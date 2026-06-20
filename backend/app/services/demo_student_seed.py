from typing import Any, Callable

from app.services.demo_student_profiles import build_demo_student_specs


class DemoStudentSeeder:
    def __init__(
        self,
        *,
        id_for: Callable[[str, str], str],
        date_for: Callable[[int], str],
        timestamp_for: Callable[..., str],
        insert: Callable[[str, list[dict[str, Any]]], None],
        insert_optional: Callable[[str, list[dict[str, Any]]], None],
    ):
        self._id_for = id_for
        self._date_for = date_for
        self._timestamp_for = timestamp_for
        self._insert_rows = insert
        self._insert_optional_rows = insert_optional

    def _id(self, studio_id: str, key: str) -> str:
        return self._id_for(studio_id, key)

    def _date(self, days_from_today: int) -> str:
        return self._date_for(days_from_today)

    def _timestamp(self, days_from_today: int = 0, hour: int = 9, minute: int = 0) -> str:
        return self._timestamp_for(days_from_today, hour, minute)

    def _insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        self._insert_rows(table, rows)

    def _insert_optional(self, table: str, rows: list[dict[str, Any]]) -> None:
        self._insert_optional_rows(table, rows)

    def seed_students(
        self,
        studio_id: str,
        program_ids: dict[str, str],
        rank_ids: dict[str, str],
    ) -> dict[str, str]:
        now = self._timestamp()
        student_specs = build_demo_student_specs(
            date_for=self._date,
            program_ids=program_ids,
            rank_ids=rank_ids,
        )
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
