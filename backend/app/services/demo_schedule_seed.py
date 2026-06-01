from __future__ import annotations

from typing import Any, Callable


class DemoScheduleSeeder:
    def __init__(
        self,
        *,
        id_for: Callable[[str, str], str],
        date_for: Callable[[int], str],
        timestamp_for: Callable[..., str],
        insert: Callable[[str, list[dict[str, Any]]], None],
        weekday_for: Callable[[int], int],
    ):
        self._id_for = id_for
        self._date_for = date_for
        self._timestamp_for = timestamp_for
        self._insert_rows = insert
        self._weekday_for = weekday_for

    def _id(self, studio_id: str, key: str) -> str:
        return self._id_for(studio_id, key)

    def _date(self, days_from_today: int) -> str:
        return self._date_for(days_from_today)

    def _timestamp(self, days_from_today: int = 0, hour: int = 9, minute: int = 0) -> str:
        return self._timestamp_for(days_from_today, hour, minute)

    def _weekday(self, days_from_today: int = 0) -> int:
        return self._weekday_for(days_from_today)

    def _insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        self._insert_rows(table, rows)

    def seed_schedule(
        self,
        studio_id: str,
        program_ids: dict[str, str],
        student_ids: dict[str, str],
    ) -> None:
        now = self._timestamp()
        template_specs = [
            ("kids-bjj-today", "Kids BJJ Fundamentals", 0, "16:00", "16:45", program_ids["bjj_core"], 20),
            ("adult-nogi-today", "Adult No-Gi", 0, "18:00", "19:30", program_ids["bjj_core"], 28),
            ("morning-fundamentals", "Morning BJJ Fundamentals", 0, "06:30", "07:30", program_ids["bjj_core"], 18),
            ("tae-kwon-do-tomorrow", "Tae Kwon Do Fundamentals", 1, "17:30", "18:30", program_ids["tae_kwon_do"], 24),
            ("competition-prep", "Competition Prep", 2, "17:00", "18:30", program_ids["bjj_core"], 16),
            ("family-open-mat", "Family Open Mat", 5, "10:00", "11:30", program_ids["bjj_core"], 30),
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
        tkd_historical_offsets = [-88, -81, -74, -67, -60, -53, -46, -39, -32, -25, -18, -11, -4]
        for index, offset in enumerate(tkd_historical_offsets):
            sessions.append(
                {
                    "id": self._id(studio_id, f"session:tkd-history:{index}"),
                    "studio_id": studio_id,
                    "template_id": None,
                    "name": "Tae Kwon Do Forms & Sparring",
                    "date": self._date(offset),
                    "start_time": "17:30",
                    "end_time": "18:30",
                    "program_id": program_ids["tae_kwon_do"],
                    "capacity": 24,
                    "status": "completed",
                    "created_at": self._timestamp(offset, 8),
                }
            )

        today_sessions = [
            ("today-morning", "Morning BJJ Fundamentals", "06:30", "07:30", program_ids["bjj_core"], 18, "morning-fundamentals"),
            ("today-kids", "Kids BJJ Fundamentals", "16:00", "16:45", program_ids["bjj_core"], 20, "kids-bjj-today"),
            ("today-adult", "Adult No-Gi", "18:00", "19:30", program_ids["bjj_core"], 28, "adult-nogi-today"),
            ("today-tae-kwon-do", "Tae Kwon Do Fundamentals", "19:45", "20:30", program_ids["tae_kwon_do"], 24, None),
            ("future-open-mat", "Family Open Mat", "10:00", "11:30", program_ids["bjj_core"], 30, "family-open-mat"),
        ]
        for key, name, start, end, program_id, capacity, template_key in today_sessions:
            sessions.append(
                {
                    "id": self._id(studio_id, f"session:{key}"),
                    "studio_id": studio_id,
                    "template_id": self._id(studio_id, f"template:{template_key}") if template_key else None,
                    "name": name,
                    "date": self._date(5 if key == "future-open-mat" else 0),
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
        tkd_history_session_ids = [
            self._id(studio_id, f"session:tkd-history:{index}")
            for index in range(len(tkd_historical_offsets))
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
            "grace": 1,
            "julian": 14,
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
            "rebecca": "Rebecca Nguyen",
            "miles": "Miles Brooks",
            "grace": "Grace Miller",
            "julian": "Julian Bennett",
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

        tkd_attendance_counts = {
            "sofia": 3,
            "isabel": 2,
            "omar": 6,
            "chloe": 7,
            "diego": 10,
            "ellie": 4,
            "rebecca": 13,
            "miles": 12,
        }
        for student_key, count in tkd_attendance_counts.items():
            for index, session_id in enumerate(tkd_history_session_ids[-count:]):
                attendance_rows.append(
                    {
                        "id": self._id(studio_id, f"attendance:{student_key}:tkd-history:{index}"),
                        "studio_id": studio_id,
                        "session_id": session_id,
                        "student_id": student_ids[student_key],
                        "status": "late" if index == count - 1 and student_key in {"chloe", "miles"} else "present",
                        "checked_in_at": self._timestamp(tkd_historical_offsets[-count + index], 17, 40),
                        "checked_in_by": None,
                    }
                )

        today_attendance = [
            ("today-morning", "marcus", "present"),
            ("today-morning", "maya", "present"),
            ("today-morning", "ben", "present"),
            ("today-morning", "lucas", "late"),
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
            ("today-kids", "julian", "present"),
            ("today-kids", "grace", "excused"),
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
            ("today-tae-kwon-do", "rebecca", "present"),
            ("today-tae-kwon-do", "miles", "present"),
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
                        6 if session_key == "today-morning" else 16 if session_key == "today-kids" else 19 if session_key == "today-tae-kwon-do" else 18,
                        10,
                    ),
                    "checked_in_by": None,
                }
            )

        self._insert("attendance", attendance_rows)
