import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from supabase import Client

from app.schemas.demo import DemoResetCounts, DemoResetResponse
from app.schemas.schedule import AttendanceResponse
from app.services.belt_service import BeltService
from app.services.lead_service import LeadService
from app.services.schedule_service import ScheduleService
from app.services.student_service import StudentService


DEMO_STUDIO_NAME = "River City Martial Arts"
DEMO_NAMESPACE = uuid.UUID("7d8a064e-135e-47b6-8c6b-c1c4d65b7f82")


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

    def _fetch_ids(self, table: str, studio_id: str) -> list[str]:
        result = self.supabase.table(table).select("id").eq("studio_id", studio_id).execute()
        return [row["id"] for row in (result.data or []) if row.get("id")]

    def _insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        if rows:
            self.supabase.table(table).insert(rows).execute()

    def _clear_demo_surface(self, studio_id: str) -> None:
        student_ids = self._fetch_ids("students", studio_id)
        guardian_ids = self._fetch_ids("guardians", studio_id)

        self._delete_by_studio("attendance", studio_id)
        self._delete_by_studio("promotions", studio_id)
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
            "kids_bjj": {
                "id": self._id(studio_id, "program:kids-bjj"),
                "studio_id": studio_id,
                "name": "Kids Brazilian Jiu-Jitsu",
                "description": "Ages 7-12 fundamentals, confidence, and safe movement.",
                "created_at": now,
            },
            "adult_bjj": {
                "id": self._id(studio_id, "program:adult-bjj"),
                "studio_id": studio_id,
                "name": "Adult Brazilian Jiu-Jitsu",
                "description": "Fundamentals, no-gi, and competition development.",
                "created_at": now,
            },
            "muay_thai": {
                "id": self._id(studio_id, "program:muay-thai"),
                "studio_id": studio_id,
                "name": "Muay Thai Fundamentals",
                "description": "Beginner striking, footwork, and conditioning.",
                "created_at": now,
            },
        }
        self._insert("programs", list(programs.values()))
        return {key: row["id"] for key, row in programs.items()}

    def _seed_belts(self, studio_id: str) -> dict[str, str]:
        now = self._timestamp()
        ladder_id = self._id(studio_id, "ladder:bjj-core")
        self._insert(
            "belt_ladders",
            [
                {
                    "id": ladder_id,
                    "studio_id": studio_id,
                    "name": "Brazilian Jiu-Jitsu Core",
                    "program_id": None,
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
        self._insert("belt_ranks", rank_rows)
        rank_ids["ladder"] = ladder_id
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
                "program": program_ids["kids_bjj"],
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
                "program": program_ids["kids_bjj"],
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
                "program": program_ids["kids_bjj"],
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
                "program": program_ids["kids_bjj"],
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
                "program": program_ids["adult_bjj"],
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
                "program": program_ids["muay_thai"],
                "rank": None,
                "tags": ["trial", "muay-thai"],
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
                "program": program_ids["adult_bjj"],
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
                "program": program_ids["adult_bjj"],
                "rank": rank_ids["yellow"],
                "tags": ["adult", "medical-hold"],
                "notes": "On medical hold; excluded from inactivity alerts while hold is active.",
                "guardian": None,
                "hold_start": self._date(-14),
                "hold_end": self._date(30),
            },
        ]

        student_rows = []
        guardian_rows = []
        join_rows = []
        student_ids: dict[str, str] = {}

        for spec in student_specs:
            student_id = self._id(studio_id, f"student:{spec['key']}")
            student_ids[spec["key"]] = student_id
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
        self._insert("guardians", guardian_rows)
        self._insert("student_guardians", join_rows)
        return student_ids

    def _seed_promotions(
        self,
        studio_id: str,
        actor_id: str,
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
        ]
        rows = []
        for student_key, from_key, to_key, offset, notes in promotion_specs:
            rows.append(
                {
                    "id": self._id(studio_id, f"promotion:{student_key}:{to_key}"),
                    "studio_id": studio_id,
                    "student_id": student_ids[student_key],
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
            ("kids-bjj-today", "Kids BJJ Fundamentals", 0, "16:00", "16:45", program_ids["kids_bjj"], 20),
            ("adult-nogi-today", "Adult No-Gi", 0, "18:00", "19:30", program_ids["adult_bjj"], 28),
            ("muay-thai-tomorrow", "Muay Thai Fundamentals", 1, "17:30", "18:30", program_ids["muay_thai"], 24),
            ("competition-prep", "Competition Prep", 2, "17:00", "18:30", program_ids["adult_bjj"], 16),
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
                    "program_id": program_ids["adult_bjj"] if index % 3 == 0 else program_ids["kids_bjj"],
                    "capacity": 24,
                    "status": "completed",
                    "created_at": self._timestamp(offset, 8),
                }
            )

        today_sessions = [
            ("today-kids", "Kids BJJ Fundamentals", "16:00", "16:45", program_ids["kids_bjj"], 20, "kids-bjj-today"),
            ("today-adult", "Adult No-Gi", "18:00", "19:30", program_ids["adult_bjj"], 28, "adult-nogi-today"),
            ("today-muay", "Muay Thai Fundamentals", "19:45", "20:30", program_ids["muay_thai"], 24, None),
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
            "sofia": 1,
        }
        student_names = {
            "aiko": "Aiko Tanaka",
            "mateo": "Mateo Cruz",
            "priya": "Priya Sharma",
            "nina": "Nina Patel",
            "marcus": "Marcus Webb",
            "sofia": "Sofia Reyes",
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
            ("today-adult", "marcus", "present"),
            ("today-muay", "sofia", "present"),
        ]
        for session_key, student_key, status_value in today_attendance:
            attendance_rows.append(
                {
                    "id": self._id(studio_id, f"attendance:{session_key}:{student_key}"),
                    "studio_id": studio_id,
                    "session_id": self._id(studio_id, f"session:{session_key}"),
                    "student_id": student_ids[student_key],
                    "status": status_value,
                    "checked_in_at": self._timestamp(0, 16 if session_key == "today-kids" else 18, 10),
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
                "Kids Brazilian Jiu-Jitsu",
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
                "Adult Brazilian Jiu-Jitsu",
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
                "Muay Thai Fundamentals",
                False,
                None,
                None,
                None,
                self._date(0),
                None,
                "Loved the pad work; price sheet sent.",
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
                "Kids Brazilian Jiu-Jitsu",
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
                "Adult Brazilian Jiu-Jitsu",
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
        rank_ids = self._seed_belts(studio_id)
        student_ids = self._seed_students(studio_id, program_ids, rank_ids)
        self._seed_promotions(studio_id, actor_id, student_ids, rank_ids)
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
