import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.schemas.demo import DemoResetCounts, DemoResetResponse
from app.schemas.schedule import AttendanceResponse
from app.services.belt_service import BeltService
from app.services.lead_service import LeadService
from app.services.program_service import ProgramService
from app.services.schedule_service import ScheduleService
from app.services.student_service import StudentService


DEMO_STUDIO_NAME = "River City Martial Arts"
DEMO_NAMESPACE = uuid.UUID("7d8a064e-135e-47b6-8c6b-c1c4d65b7f82")
OPTIONAL_SCHEMA_ERROR_CODES = {"42P01", "42703", "PGRST204", "PGRST205"}


class DemoService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def _id(self, studio_id: str, key: str) -> str:
        return str(uuid.uuid5(DEMO_NAMESPACE, f"{studio_id}:{key}"))

    def _today(self) -> date:
        return date.today()

    def _date(self, days_from_today: int) -> str:
        return (self._today() + timedelta(days=days_from_today)).isoformat()

    def _timestamp(self, days_from_today: int = 0, hour: int = 9, minute: int = 0) -> str:
        value = datetime.combine(
            self._today() + timedelta(days=days_from_today),
            time(hour=hour, minute=minute),
            tzinfo=timezone.utc,
        )
        return value.isoformat()

    def _weekday(self, days_from_today: int = 0) -> int:
        # Python: Monday=0 ... Sunday=6. Koaryu schema: Sunday=0 ... Saturday=6.
        return ((self._today() + timedelta(days=days_from_today)).weekday() + 1) % 7

    def _delete_by_studio(self, table: str, studio_id: str) -> None:
        self.supabase.table(table).delete().eq("studio_id", studio_id).execute()

    def _delete_optional_by_studio(self, table: str, studio_id: str) -> None:
        try:
            self._delete_by_studio(table, studio_id)
        except PostgrestAPIError as exc:
            if exc.code not in OPTIONAL_SCHEMA_ERROR_CODES:
                raise

    def _fetch_ids(self, table: str, studio_id: str) -> list[str]:
        result = self.supabase.table(table).select("id").eq("studio_id", studio_id).execute()
        return [row["id"] for row in (result.data or []) if row.get("id")]

    def _insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        if rows:
            self.supabase.table(table).insert(rows).execute()

    def _insert_optional(self, table: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        try:
            self._insert(table, rows)
        except PostgrestAPIError as exc:
            if exc.code not in OPTIONAL_SCHEMA_ERROR_CODES:
                raise

    def _clear_demo_surface(self, studio_id: str) -> None:
        student_ids = self._fetch_ids("students", studio_id)
        guardian_ids = self._fetch_ids("guardians", studio_id)

        self._delete_by_studio("attendance", studio_id)
        self._delete_by_studio("promotions", studio_id)
        self._delete_optional_by_studio("student_program_memberships", studio_id)
        self._delete_by_studio("lead_activities", studio_id)
        self._delete_by_studio("student_import_runs", studio_id)
        self._delete_by_studio("leads", studio_id)

        if student_ids:
            self.supabase.table("student_guardians").delete().in_("student_id", student_ids).execute()
        if guardian_ids:
            self.supabase.table("student_guardians").delete().in_("guardian_id", guardian_ids).execute()

        self._delete_by_studio("class_sessions", studio_id)
        self._delete_by_studio("class_templates", studio_id)
        self._delete_by_studio("students", studio_id)
        self._delete_by_studio("guardians", studio_id)
        self._delete_by_studio("belt_ranks", studio_id)
        self._delete_by_studio("belt_ladders", studio_id)
        self._delete_by_studio("programs", studio_id)

    def _seed_programs(self, studio_id: str) -> dict[str, str]:
        now = self._timestamp()
        programs = {
            "bjj_core": {
                "id": self._id(studio_id, "program:bjj-core"),
                "studio_id": studio_id,
                "name": "Brazilian Jiu-Jitsu Core",
                "description": "Shared belt progression for kids, adults, fundamentals, and no-gi.",
                "created_at": now,
            },
            "tae_kwon_do": {
                "id": self._id(studio_id, "program:tae-kwon-do"),
                "studio_id": studio_id,
                "name": "Tae Kwon Do Fundamentals",
                "description": "Foundational forms, footwork, sparring, and confidence.",
                "created_at": now,
            },
        }
        self._insert("programs", list(programs.values()))
        return {key: row["id"] for key, row in programs.items()}

    def _seed_belts(self, studio_id: str, program_ids: dict[str, str]) -> dict[str, str]:
        now = self._timestamp()
        ladder_id = self._id(studio_id, "ladder:bjj-core")
        tkd_ladder_id = self._id(studio_id, "ladder:tae-kwon-do")
        self._insert(
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
                }
            ],
        )

        rank_specs = [
            ("white", "White Belt", "#FFFFFF", 0, 0, 0, False, False, None),
            ("white-stripe-1", "White Stripe 1", "#FFFFFF", 1, 6, 1, False, True, "#EF4444"),
            ("white-stripe-2", "White Stripe 2", "#FFFFFF", 2, 8, 1, False, True, "#EF4444"),
            ("white-stripe-3", "White Stripe 3", "#FFFFFF", 3, 10, 1, False, True, "#111111"),
            ("yellow", "Yellow Belt", "#EAB308", 4, 12, 2, True, False, None),
            ("orange", "Orange Belt", "#F97316", 5, 16, 3, True, False, None),
            ("green", "Green Belt", "#22C55E", 6, 20, 4, True, False, None),
        ]
        rank_rows = []
        rank_ids: dict[str, str] = {}
        for key, name, color, order, classes, months, approval, is_tip, tip_color in rank_specs:
            rank_id = self._id(studio_id, f"rank:{key}")
            rank_ids[key] = rank_id
            rank_rows.append(
                {
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
            )
        tkd_rank_specs = [
            ("tkd-white", "White Belt", "#FFFFFF", 0, 0, 0, False, False, None),
            ("tkd-yellow-stripe", "Yellow Stripe", "#FFFFFF", 1, 5, 1, False, True, "#EAB308"),
            ("tkd-yellow", "Yellow Belt", "#EAB308", 2, 10, 2, True, False, None),
            ("tkd-green-stripe", "Green Stripe", "#FFFFFF", 3, 14, 3, False, True, "#22C55E"),
            ("tkd-green", "Green Belt", "#22C55E", 4, 18, 4, True, False, None),
            ("tkd-blue-stripe", "Blue Stripe", "#FFFFFF", 5, 22, 5, False, True, "#3B82F6"),
            ("tkd-blue", "Blue Belt", "#3B82F6", 6, 28, 6, True, False, None),
        ]
        for key, name, color, order, classes, months, approval, is_tip, tip_color in tkd_rank_specs:
            rank_id = self._id(studio_id, f"rank:{key}")
            rank_ids[key] = rank_id
            rank_rows.append(
                {
                    "id": rank_id,
                    "ladder_id": tkd_ladder_id,
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
            )
        self._insert("belt_ranks", rank_rows)
        rank_ids["ladder"] = ladder_id
        rank_ids["tkd_ladder"] = tkd_ladder_id
        return rank_ids

    def _seed_students(
        self,
        studio_id: str,
        program_ids: dict[str, str],
        rank_ids: dict[str, str],
    ) -> dict[str, str]:
        now = self._timestamp()
        student_specs = [
            {
                "key": "aiko",
                "first": "Aiko",
                "last": "Tanaka",
                "preferred": "Aiko",
                "dob": "2015-03-12",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-610),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white-stripe-2"],
                "tags": ["youth", "competition", "demo-ready"],
                "notes": "Quietly technical; ready to show promotion eligibility.",
                "guardian": ("Kenji", "Tanaka", "kenji.tanaka@example.test", "(555) 234-5678", "Father"),
            },
            {
                "key": "mateo",
                "first": "Mateo",
                "last": "Cruz",
                "preferred": "Mateo",
                "dob": "2013-06-04",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-420),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white-stripe-3"],
                "tags": ["youth", "leadership"],
                "notes": "Consistent attendance; next promotion requires instructor approval.",
                "guardian": ("Elena", "Cruz", "elena.cruz@example.test", "(555) 238-1199", "Mother"),
            },
            {
                "key": "priya",
                "first": "Priya",
                "last": "Sharma",
                "preferred": "Priya",
                "dob": "2010-09-18",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-300),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white"],
                "tags": ["youth", "attendance-watch"],
                "notes": "Classes are on track; needs a little more time at rank.",
                "guardian": ("Raj", "Sharma", "raj.sharma@example.test", "(555) 567-8901", "Father"),
            },
            {
                "key": "nina",
                "first": "Nina",
                "last": "Patel",
                "preferred": "Nina",
                "dob": "2011-01-21",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-150),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white-stripe-1"],
                "tags": ["youth", "new-family"],
                "notes": "Newer student with a few classes toward the next stripe.",
                "guardian": ("Anika", "Patel", "anika.patel@example.test", "(555) 410-2209", "Mother"),
            },
            {
                "key": "marcus",
                "first": "Marcus",
                "last": "Webb",
                "preferred": "Marc",
                "dob": "1992-07-22",
                "email": "marcus.webb@example.test",
                "phone": "(555) 876-5432",
                "status": "active",
                "membership": self._date(-910),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["yellow"],
                "tags": ["adult", "competitor"],
                "notes": "Competition team regular; good profile for attendance history.",
                "guardian": None,
            },
            {
                "key": "sofia",
                "first": "Sofia",
                "last": "Reyes",
                "preferred": None,
                "dob": "2012-11-30",
                "email": None,
                "phone": None,
                "status": "trialing",
                "membership": self._date(-9),
                "program": program_ids["tae_kwon_do"],
                "rank": rank_ids["tkd-white"],
                "tags": ["trial", "tae-kwon-do"],
                "notes": "Trial family from the spring open house.",
                "guardian": ("Carmen", "Reyes", "carmen.reyes@example.test", "(555) 345-6789", "Mother"),
            },
            {
                "key": "derek",
                "first": "Derek",
                "last": "Kim",
                "preferred": "Derek",
                "dob": "1988-04-05",
                "email": "derek.kim@example.test",
                "phone": "(555) 456-7890",
                "status": "inactive",
                "membership": self._date(-1200),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["orange"],
                "tags": ["adult", "alumni"],
                "notes": "Moved out of town. Keep for inactive roster visibility.",
                "guardian": None,
            },
            {
                "key": "james",
                "first": "James",
                "last": "O'Brien",
                "preferred": "Jimmy",
                "dob": "1979-12-01",
                "email": "james.obrien@example.test",
                "phone": "(555) 678-9012",
                "status": "paused",
                "membership": self._date(-980),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["yellow"],
                "tags": ["adult", "medical-hold"],
                "notes": "On medical hold; excluded from inactivity alerts while hold is active.",
                "guardian": None,
                "hold_start": self._date(-14),
                "hold_end": self._date(30),
            },
        ]
        student_specs.extend([
            {
                "key": "hana",
                "first": "Hana",
                "last": "Mori",
                "preferred": "Hana",
                "dob": "2016-02-08",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-260),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white-stripe-1"],
                "tags": ["youth", "beginner"],
                "notes": "Steady beginner who pairs well with newer students.",
                "guardian": ("Yumi", "Mori", "yumi.mori@example.test", "(555) 241-0101", "Mother"),
            },
            {
                "key": "liam",
                "first": "Liam",
                "last": "Johnson",
                "preferred": "Liam",
                "dob": "2014-05-19",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-95),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white"],
                "tags": ["youth", "new-family"],
                "notes": "Newer student building class consistency.",
                "guardian": ("Megan", "Johnson", "megan.johnson@example.test", "(555) 241-0102", "Mother"),
            },
            {
                "key": "ava",
                "first": "Ava",
                "last": "Martinez",
                "preferred": "Ava",
                "dob": "2013-10-02",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-390),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white-stripe-2"],
                "tags": ["youth", "attendance-strong"],
                "notes": "Consistent classes and strong retention drills.",
                "guardian": ("Rosa", "Martinez", "rosa.martinez@example.test", "(555) 241-0103", "Mother"),
            },
            {
                "key": "noah_b",
                "first": "Noah",
                "last": "Bennett",
                "preferred": "Noah",
                "dob": "2012-12-11",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-510),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white-stripe-3"],
                "tags": ["youth", "promotion-watch"],
                "notes": "Close to yellow belt once approval is complete.",
                "guardian": ("Claire", "Bennett", "claire.bennett@example.test", "(555) 241-0104", "Mother"),
            },
            {
                "key": "zara",
                "first": "Zara",
                "last": "Ali",
                "preferred": "Zara",
                "dob": "2015-07-30",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-185),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white"],
                "tags": ["youth", "confidence"],
                "notes": "Developing confidence in live drills.",
                "guardian": ("Samira", "Ali", "samira.ali@example.test", "(555) 241-0105", "Mother"),
            },
            {
                "key": "ethan",
                "first": "Ethan",
                "last": "Wong",
                "preferred": "Ethan",
                "dob": "2011-04-17",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-720),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["yellow"],
                "tags": ["youth", "assistant-helper"],
                "notes": "Helps newer kids with warmups.",
                "guardian": ("Michelle", "Wong", "michelle.wong@example.test", "(555) 241-0106", "Mother"),
            },
            {
                "key": "lucas",
                "first": "Lucas",
                "last": "Grant",
                "preferred": "Lucas",
                "dob": "1990-08-03",
                "email": "lucas.grant@example.test",
                "phone": "(555) 241-0107",
                "status": "active",
                "membership": self._date(-140),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white-stripe-1"],
                "tags": ["adult", "evening"],
                "notes": "Usually attends the evening no-gi block.",
                "guardian": None,
            },
            {
                "key": "maya",
                "first": "Maya",
                "last": "Chen",
                "preferred": "Maya",
                "dob": "1986-09-27",
                "email": "maya.chen@example.test",
                "phone": "(555) 241-0108",
                "status": "active",
                "membership": self._date(-1100),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["orange"],
                "tags": ["adult", "mentor"],
                "notes": "Reliable mentor for fundamentals students.",
                "guardian": None,
            },
            {
                "key": "oliver",
                "first": "Oliver",
                "last": "Stone",
                "preferred": "Ollie",
                "dob": "1998-01-06",
                "email": "oliver.stone@example.test",
                "phone": "(555) 241-0109",
                "status": "active",
                "membership": self._date(-60),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white"],
                "tags": ["adult", "trial-converted"],
                "notes": "Recently converted from a trial.",
                "guardian": None,
            },
            {
                "key": "amara",
                "first": "Amara",
                "last": "Okafor",
                "preferred": "Amara",
                "dob": "1993-03-25",
                "email": "amara.okafor@example.test",
                "phone": "(555) 241-0110",
                "status": "active",
                "membership": self._date(-1380),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["green"],
                "tags": ["adult", "cross-training"],
                "notes": "Advanced BJJ student also cross-training in Tae Kwon Do.",
                "guardian": None,
                "extra_programs": [
                    {"program": program_ids["tae_kwon_do"], "rank": rank_ids["tkd-white"], "status": "active", "started_at": self._date(-45)}
                ],
            },
            {
                "key": "ben",
                "first": "Ben",
                "last": "Carter",
                "preferred": "Ben",
                "dob": "1984-11-09",
                "email": "ben.carter@example.test",
                "phone": "(555) 241-0111",
                "status": "active",
                "membership": self._date(-310),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white-stripe-2"],
                "tags": ["adult", "morning"],
                "notes": "Morning class regular.",
                "guardian": None,
            },
            {
                "key": "isabella",
                "first": "Isabella",
                "last": "Rossi",
                "preferred": "Bella",
                "dob": "2014-03-14",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-235),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white-stripe-1"],
                "tags": ["youth", "after-school"],
                "notes": "After-school student with strong attendance.",
                "guardian": ("Gianna", "Rossi", "gianna.rossi@example.test", "(555) 241-0112", "Mother"),
            },
            {
                "key": "kai",
                "first": "Kai",
                "last": "Thompson",
                "preferred": "Kai",
                "dob": "2010-06-23",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-980),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["orange"],
                "tags": ["youth", "competition"],
                "notes": "Competition-focused youth student.",
                "guardian": ("Andre", "Thompson", "andre.thompson@example.test", "(555) 241-0113", "Father"),
            },
            {
                "key": "mia_j",
                "first": "Mia",
                "last": "Johnson",
                "preferred": "Mia",
                "dob": "2016-09-01",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-120),
                "program": program_ids["bjj_core"],
                "rank": rank_ids["white"],
                "tags": ["youth", "new-family"],
                "notes": "Good fit for beginner fundamentals.",
                "guardian": ("Dana", "Johnson", "dana.johnson@example.test", "(555) 241-0114", "Mother"),
            },
            {
                "key": "isabel",
                "first": "Isabel",
                "last": "Torres",
                "preferred": "Izzy",
                "dob": "2012-02-28",
                "email": None,
                "phone": None,
                "status": "trialing",
                "membership": self._date(-6),
                "program": program_ids["tae_kwon_do"],
                "rank": rank_ids["tkd-white"],
                "tags": ["youth", "tae-kwon-do", "trial"],
                "notes": "Trying the youth Tae Kwon Do track.",
                "guardian": ("Marisol", "Torres", "marisol.torres@example.test", "(555) 241-0115", "Mother"),
            },
            {
                "key": "omar",
                "first": "Omar",
                "last": "Haddad",
                "preferred": "Omar",
                "dob": "1991-05-05",
                "email": "omar.haddad@example.test",
                "phone": "(555) 241-0116",
                "status": "active",
                "membership": self._date(-80),
                "program": program_ids["tae_kwon_do"],
                "rank": rank_ids["tkd-yellow"],
                "tags": ["adult", "tae-kwon-do", "cross-training"],
                "notes": "Primary Tae Kwon Do student also taking BJJ basics.",
                "guardian": None,
                "extra_programs": [
                    {"program": program_ids["bjj_core"], "rank": rank_ids["white"], "status": "active", "started_at": self._date(-25)}
                ],
            },
            {
                "key": "chloe",
                "first": "Chloe",
                "last": "Park",
                "preferred": "Chloe",
                "dob": "2013-08-20",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-130),
                "program": program_ids["tae_kwon_do"],
                "rank": rank_ids["tkd-yellow-stripe"],
                "tags": ["youth", "tae-kwon-do"],
                "notes": "Building confidence through forms and footwork drills.",
                "guardian": ("Jin", "Park", "jin.park@example.test", "(555) 241-0117", "Father"),
            },
            {
                "key": "diego",
                "first": "Diego",
                "last": "Flores",
                "preferred": "Diego",
                "dob": "1989-12-12",
                "email": "diego.flores@example.test",
                "phone": "(555) 241-0118",
                "status": "active",
                "membership": self._date(-210),
                "program": program_ids["tae_kwon_do"],
                "rank": rank_ids["tkd-yellow"],
                "tags": ["adult", "tae-kwon-do"],
                "notes": "Regular Tae Kwon Do student.",
                "guardian": None,
            },
            {
                "key": "ellie",
                "first": "Ellie",
                "last": "Smith",
                "preferred": "Ellie",
                "dob": "2015-01-16",
                "email": None,
                "phone": None,
                "status": "active",
                "membership": self._date(-70),
                "program": program_ids["tae_kwon_do"],
                "rank": rank_ids["tkd-white"],
                "tags": ["youth", "tae-kwon-do", "beginner"],
                "notes": "New beginner in the Tae Kwon Do program.",
                "guardian": ("Paula", "Smith", "paula.smith@example.test", "(555) 241-0119", "Mother"),
            },
            {
                "key": "sam",
                "first": "Sam",
                "last": "Wilson",
                "preferred": "Sam",
                "dob": "1982-07-07",
                "email": "sam.wilson@example.test",
                "phone": "(555) 241-0120",
                "status": "paused",
                "membership": self._date(-410),
                "program": program_ids["tae_kwon_do"],
                "rank": rank_ids["tkd-green-stripe"],
                "tags": ["adult", "tae-kwon-do", "travel-hold"],
                "notes": "Paused while traveling for work.",
                "guardian": None,
                "hold_start": self._date(-7),
                "hold_end": self._date(21),
            },
        ])

        student_rows = []
        membership_rows = []
        guardian_rows = []
        join_rows = []
        student_ids: dict[str, str] = {}

        for spec in student_specs:
            student_id = self._id(studio_id, f"student:{spec['key']}")
            student_ids[spec["key"]] = student_id
            membership_status = "paused" if spec["status"] == "paused" else "active"
            membership_ended_at = None
            if spec["status"] in {"inactive", "canceled"}:
                membership_status = "ended"
                membership_ended_at = self._date(-1)
            student_rows.append(
                {
                    "id": student_id,
                    "studio_id": studio_id,
                    "legal_first_name": spec["first"],
                    "legal_last_name": spec["last"],
                    "preferred_name": spec["preferred"],
                    "date_of_birth": spec["dob"],
                    "email": spec["email"],
                    "phone": spec["phone"],
                    "status": spec["status"],
                    "membership_start_date": spec["membership"],
                    "program_id": spec["program"],
                    "current_belt_rank_id": spec["rank"],
                    "notes": spec["notes"],
                    "tags": spec["tags"],
                    "hold_start_date": spec.get("hold_start"),
                    "hold_end_date": spec.get("hold_end"),
                    "created_at": now,
                    "updated_at": now,
                }
            )
            membership_rows.append(
                {
                    "id": self._id(studio_id, f"student-program:{spec['key']}"),
                    "studio_id": studio_id,
                    "student_id": student_id,
                    "program_id": spec["program"],
                    "status": membership_status,
                    "started_at": spec["membership"],
                    "ended_at": membership_ended_at,
                    "current_belt_rank_id": spec["rank"],
                    "created_at": now,
                    "updated_at": now,
                }
            )
            for index, extra_program in enumerate(spec.get("extra_programs", []), start=1):
                extra_status = extra_program.get("status", "active")
                membership_rows.append(
                    {
                        "id": self._id(studio_id, f"student-program:{spec['key']}:extra:{index}"),
                        "studio_id": studio_id,
                        "student_id": student_id,
                        "program_id": extra_program["program"],
                        "status": extra_status,
                        "started_at": extra_program.get("started_at", spec["membership"]),
                        "ended_at": self._date(-1) if extra_status == "ended" else None,
                        "current_belt_rank_id": extra_program.get("rank"),
                        "created_at": now,
                        "updated_at": now,
                    }
                )
            if spec["guardian"]:
                first, last, email, phone, relation = spec["guardian"]
                guardian_id = self._id(studio_id, f"guardian:{spec['key']}")
                guardian_rows.append(
                    {
                        "id": guardian_id,
                        "studio_id": studio_id,
                        "first_name": first,
                        "last_name": last,
                        "email": email,
                        "phone": phone,
                        "relation": relation,
                        "is_primary_contact": True,
                        "created_at": now,
                    }
                )
                join_rows.append(
                    {
                        "id": self._id(studio_id, f"student-guardian:{spec['key']}"),
                        "student_id": student_id,
                        "guardian_id": guardian_id,
                    }
                )

        self._insert("students", student_rows)
        self._insert_optional("student_program_memberships", membership_rows)
        self._insert("guardians", guardian_rows)
        self._insert("student_guardians", join_rows)
        return student_ids

    def _seed_promotions(
        self,
        studio_id: str,
        actor_id: str,
        program_ids: dict[str, str],
        student_ids: dict[str, str],
        rank_ids: dict[str, str],
    ) -> None:
        promotion_specs = [
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
        ]
        rows = []
        for student_key, from_key, to_key, offset, notes in promotion_specs:
            rows.append(
                {
                    "id": self._id(studio_id, f"promotion:{student_key}:{to_key}"),
                    "studio_id": studio_id,
                    "student_id": student_ids[student_key],
                    "student_program_membership_id": self._id(studio_id, f"student-program:{student_key}"),
                    "program_id": program_ids["bjj_core"],
                    "from_rank_id": rank_ids[from_key] if from_key else None,
                    "to_rank_id": rank_ids[to_key],
                    "promoted_by": actor_id,
                    "notes": notes,
                    "promoted_at": self._timestamp(offset, 18, 30),
                }
            )
        self._insert("promotions", rows)

    def _seed_schedule(
        self,
        studio_id: str,
        program_ids: dict[str, str],
        student_ids: dict[str, str],
    ) -> None:
        now = self._timestamp()
        template_specs = [
            ("kids-bjj-today", "Kids BJJ Fundamentals", 0, "16:00", "16:45", program_ids["bjj_core"], 20),
            ("adult-nogi-today", "Adult No-Gi", 0, "18:00", "19:30", program_ids["bjj_core"], 28),
            ("tae-kwon-do-tomorrow", "Tae Kwon Do Fundamentals", 1, "17:30", "18:30", program_ids["tae_kwon_do"], 24),
            ("competition-prep", "Competition Prep", 2, "17:00", "18:30", program_ids["bjj_core"], 16),
        ]
        template_rows = []
        for key, name, day_offset, start, end, program_id, capacity in template_specs:
            template_rows.append(
                {
                    "id": self._id(studio_id, f"template:{key}"),
                    "studio_id": studio_id,
                    "name": name,
                    "day_of_week": self._weekday(day_offset),
                    "start_time": start,
                    "end_time": end,
                    "start_date": self._date(-21),
                    "end_date": None,
                    "program_id": program_id,
                    "capacity": capacity,
                    "is_active": True,
                    "created_at": now,
                    "updated_at": now,
                }
            )
        self._insert("class_templates", template_rows)

        sessions: list[dict[str, Any]] = []

        historical_offsets = [-96, -90, -84, -78, -72, -66, -60, -54, -48, -42, -36, -30, -24, -18, -12, -8, -4, -2]
        for index, offset in enumerate(historical_offsets):
            sessions.append(
                {
                    "id": self._id(studio_id, f"session:history:{index}"),
                    "studio_id": studio_id,
                    "template_id": None,
                    "name": "BJJ Fundamentals",
                    "date": self._date(offset),
                    "start_time": "18:00",
                    "end_time": "19:15",
                    "program_id": program_ids["bjj_core"],
                    "capacity": 24,
                    "status": "completed",
                    "created_at": self._timestamp(offset, 8),
                }
            )

        today_sessions = [
            ("today-kids", "Kids BJJ Fundamentals", "16:00", "16:45", program_ids["bjj_core"], 20, "kids-bjj-today"),
            ("today-adult", "Adult No-Gi", "18:00", "19:30", program_ids["bjj_core"], 28, "adult-nogi-today"),
            ("today-tae-kwon-do", "Tae Kwon Do Fundamentals", "19:45", "20:30", program_ids["tae_kwon_do"], 24, None),
        ]
        for key, name, start, end, program_id, capacity, template_key in today_sessions:
            sessions.append(
                {
                    "id": self._id(studio_id, f"session:{key}"),
                    "studio_id": studio_id,
                    "template_id": self._id(studio_id, f"template:{template_key}") if template_key else None,
                    "name": name,
                    "date": self._date(0),
                    "start_time": start,
                    "end_time": end,
                    "program_id": program_id,
                    "capacity": capacity,
                    "status": "scheduled",
                    "created_at": now,
                }
            )

        self._insert("class_sessions", sessions)

        history_session_ids = [
            self._id(studio_id, f"session:history:{index}")
            for index in range(len(historical_offsets))
        ]
        attendance_counts = {
            "aiko": 12,
            "mateo": 14,
            "priya": 7,
            "nina": 4,
            "marcus": 16,
            "hana": 6,
            "liam": 3,
            "ava": 11,
            "noah_b": 13,
            "zara": 5,
            "ethan": 18,
            "lucas": 8,
            "maya": 15,
            "oliver": 4,
            "amara": 18,
            "ben": 9,
            "isabella": 7,
            "kai": 17,
            "mia_j": 3,
            "omar": 2,
        }
        student_names = {
            "aiko": "Aiko Tanaka",
            "mateo": "Mateo Cruz",
            "priya": "Priya Sharma",
            "nina": "Nina Patel",
            "marcus": "Marcus Webb",
            "hana": "Hana Mori",
            "liam": "Liam Johnson",
            "ava": "Ava Martinez",
            "noah_b": "Noah Bennett",
            "zara": "Zara Ali",
            "ethan": "Ethan Wong",
            "lucas": "Lucas Grant",
            "maya": "Maya Chen",
            "oliver": "Oliver Stone",
            "amara": "Amara Okafor",
            "ben": "Ben Carter",
            "isabella": "Isabella Rossi",
            "kai": "Kai Thompson",
            "mia_j": "Mia Johnson",
            "omar": "Omar Haddad",
        }
        attendance_rows = []
        for student_key, count in attendance_counts.items():
            for index, session_id in enumerate(history_session_ids[-count:]):
                attendance_rows.append(
                    {
                        "id": self._id(studio_id, f"attendance:{student_key}:history:{index}"),
                        "studio_id": studio_id,
                        "session_id": session_id,
                        "student_id": student_ids[student_key],
                        "status": "late" if index == count - 2 and student_key in {"aiko", "marcus"} else "present",
                        "checked_in_at": self._timestamp(historical_offsets[-count + index], 18, 5),
                        "checked_in_by": None,
                    }
                )

        today_attendance = [
            ("today-kids", "aiko", "present"),
            ("today-kids", "mateo", "present"),
            ("today-kids", "priya", "late"),
            ("today-kids", "nina", "present"),
            ("today-kids", "hana", "present"),
            ("today-kids", "liam", "present"),
            ("today-kids", "ava", "present"),
            ("today-kids", "noah_b", "present"),
            ("today-kids", "isabella", "present"),
            ("today-kids", "kai", "present"),
            ("today-kids", "mia_j", "present"),
            ("today-adult", "marcus", "present"),
            ("today-adult", "lucas", "present"),
            ("today-adult", "maya", "present"),
            ("today-adult", "oliver", "late"),
            ("today-adult", "amara", "present"),
            ("today-adult", "ben", "present"),
            ("today-adult", "omar", "present"),
            ("today-tae-kwon-do", "sofia", "present"),
            ("today-tae-kwon-do", "isabel", "present"),
            ("today-tae-kwon-do", "omar", "present"),
            ("today-tae-kwon-do", "chloe", "present"),
            ("today-tae-kwon-do", "diego", "present"),
            ("today-tae-kwon-do", "ellie", "late"),
        ]
        for session_key, student_key, status_value in today_attendance:
            attendance_rows.append(
                {
                    "id": self._id(studio_id, f"attendance:{session_key}:{student_key}"),
                    "studio_id": studio_id,
                    "session_id": self._id(studio_id, f"session:{session_key}"),
                    "student_id": student_ids[student_key],
                    "status": status_value,
                    "checked_in_at": self._timestamp(
                        0,
                        16 if session_key == "today-kids" else 19 if session_key == "today-tae-kwon-do" else 18,
                        10,
                    ),
                    "checked_in_by": None,
                }
            )

        self._insert("attendance", attendance_rows)

    def _seed_leads(self, studio_id: str, actor_id: str) -> None:
        lead_specs = [
            (
                "emma",
                "Emma",
                "Brooks",
                "emma.brooks@example.test",
                "(555) 221-0144",
                "walk_in",
                "inquiry",
                "Brazilian Jiu-Jitsu Core",
                True,
                "Lauren Brooks",
                "lauren.brooks@example.test",
                "(555) 221-0145",
                self._date(0),
                None,
                "Asked about after-school classes during open mat.",
                -1,
            ),
            (
                "tyler",
                "Tyler",
                "Chen",
                "tyler.chen@example.test",
                "(555) 330-0188",
                "website",
                "trial_scheduled",
                "Brazilian Jiu-Jitsu Core",
                False,
                None,
                None,
                None,
                self._date(-2),
                None,
                "Booked a trial but needs a reminder call.",
                -5,
            ),
            (
                "mia",
                "Mia",
                "Johnson",
                "mia.johnson@example.test",
                "(555) 501-7712",
                "referral",
                "trial_completed",
                "Tae Kwon Do Fundamentals",
                False,
                None,
                None,
                None,
                self._date(0),
                None,
                "Loved the forms class; price sheet sent.",
                -7,
            ),
            (
                "olivia",
                "Olivia",
                "Grant",
                "olivia.grant@example.test",
                "(555) 620-4410",
                "social",
                "offer_sent",
                "Brazilian Jiu-Jitsu Core",
                True,
                "Dana Grant",
                "dana.grant@example.test",
                "(555) 620-4411",
                self._date(3),
                None,
                "Family deciding between two class times.",
                -10,
            ),
            (
                "noah",
                "Noah",
                "Park",
                "noah.park@example.test",
                "(555) 780-3301",
                "search",
                "closed_lost",
                "Brazilian Jiu-Jitsu Core",
                False,
                None,
                None,
                None,
                None,
                "timing",
                "Wanted mornings only. Revisit next semester.",
                -18,
            ),
        ]

        lead_rows = []
        activity_rows = []
        for (
            key,
            first,
            last,
            email,
            phone,
            source,
            stage,
            program_interest,
            is_minor,
            guardian_name,
            guardian_email,
            guardian_phone,
            follow_up,
            lost_reason,
            notes,
            created_offset,
        ) in lead_specs:
            lead_id = self._id(studio_id, f"lead:{key}")
            lead_rows.append(
                {
                    "id": lead_id,
                    "studio_id": studio_id,
                    "first_name": first,
                    "last_name": last,
                    "email": email,
                    "phone": phone,
                    "source": source,
                    "stage": stage,
                    "program_interest": program_interest,
                    "is_minor": is_minor,
                    "guardian_name": guardian_name,
                    "guardian_email": guardian_email,
                    "guardian_phone": guardian_phone,
                    "follow_up_date": follow_up,
                    "lost_reason": lost_reason,
                    "notes": notes,
                    "created_at": self._timestamp(created_offset, 13),
                    "updated_at": self._timestamp(created_offset, 13, 30),
                }
            )
            activity_rows.append(
                {
                    "id": self._id(studio_id, f"lead-activity:{key}:created"),
                    "studio_id": studio_id,
                    "lead_id": lead_id,
                    "activity_type": "note",
                    "description": f"Lead created for {program_interest}.",
                    "created_by": actor_id,
                    "created_at": self._timestamp(created_offset, 13, 5),
                }
            )
        self._insert("leads", lead_rows)
        self._insert("lead_activities", activity_rows)

    def _write_audit_log(self, studio_id: str, actor_id: str) -> None:
        self._insert(
            "audit_logs",
            [
                {
                    "id": str(uuid.uuid4()),
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "action": "demo.reset",
                    "entity_type": "studio",
                    "entity_id": studio_id,
                    "metadata": {"studio_name": DEMO_STUDIO_NAME},
                    "created_at": self._timestamp(),
                }
            ],
        )

    async def reset_demo_studio(self, studio_id: str, actor_id: str) -> DemoResetResponse:
        self._clear_demo_surface(studio_id)
        self.supabase.table("studios").update(
            {
                "name": DEMO_STUDIO_NAME,
                "timezone": "America/New_York",
            }
        ).eq("id", studio_id).execute()

        program_ids = self._seed_programs(studio_id)
        rank_ids = self._seed_belts(studio_id, program_ids)
        student_ids = self._seed_students(studio_id, program_ids, rank_ids)
        self._seed_promotions(studio_id, actor_id, program_ids, student_ids, rank_ids)
        self._seed_schedule(studio_id, program_ids, student_ids)
        self._seed_leads(studio_id, actor_id)
        self._write_audit_log(studio_id, actor_id)

        students_page = await StudentService(self.supabase).list_students(
            studio_id=studio_id,
            search=None,
            status_filter=None,
            program_id=None,
            page=1,
            page_size=200,
        )
        programs = await ProgramService(self.supabase).list_programs(studio_id, include_archived=True)
        leads = await LeadService(self.supabase).list_leads(studio_id)
        belt_ladders = await BeltService(self.supabase).list_ladders(studio_id)
        primary_belt_ladder = belt_ladders[0] if belt_ladders else None
        eligibility = (
            await BeltService(self.supabase).get_eligibility(studio_id, primary_belt_ladder.id)
            if primary_belt_ladder
            else []
        )
        templates = await ScheduleService(self.supabase).list_templates(studio_id)
        sessions = await ScheduleService(self.supabase).list_sessions(
            studio_id,
            self._date(-30),
            self._date(60),
        )
        attendance_groups = [
            await ScheduleService(self.supabase).get_session_attendance(session.id, studio_id)
            for session in sessions
        ]
        attendance = [
            AttendanceResponse(**record.model_dump())
            for group in attendance_groups
            for record in group
        ]

        return DemoResetResponse(
            studio_name=DEMO_STUDIO_NAME,
            programs=programs,
            students=students_page.items,
            leads=leads,
            lead_activities=[],
            belt_ladders=belt_ladders,
            primary_belt_ladder=primary_belt_ladder,
            eligibility=eligibility,
            templates=templates,
            sessions=sessions,
            attendance=attendance,
            counts=DemoResetCounts(
                students=len(students_page.items),
                leads=len(leads),
                belt_ranks=sum(len(ladder.ranks) for ladder in belt_ladders),
                class_sessions=len(sessions),
                attendance_records=len(attendance),
            ),
        )
