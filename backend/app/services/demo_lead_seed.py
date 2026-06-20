from __future__ import annotations

from typing import Any, Callable


class DemoLeadSeeder:
    def __init__(
        self,
        *,
        id_for: Callable[[str, str], str],
        date_for: Callable[[int], str],
        timestamp_for: Callable[..., str],
        insert: Callable[[str, list[dict[str, Any]]], None],
    ):
        self._id_for = id_for
        self._date_for = date_for
        self._timestamp_for = timestamp_for
        self._insert_rows = insert

    def _id(self, studio_id: str, key: str) -> str:
        return self._id_for(studio_id, key)

    def _date(self, days_from_today: int) -> str:
        return self._date_for(days_from_today)

    def _timestamp(self, days_from_today: int = 0, hour: int = 9, minute: int = 0) -> str:
        return self._timestamp_for(days_from_today, hour, minute)

    def _insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        self._insert_rows(table, rows)

    def seed_leads(self, studio_id: str, actor_id: str, student_ids: dict[str, str]) -> None:
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
                None,
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
                None,
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
                "mia_j",
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
                None,
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
                None,
            ),
            (
                "grace",
                "Grace",
                "Miller",
                "erin.miller@example.test",
                "(555) 241-0122",
                "website",
                "trial_scheduled",
                "Brazilian Jiu-Jitsu Core",
                True,
                "Erin Miller",
                "erin.miller@example.test",
                "(555) 241-0122",
                self._date(1),
                None,
                "Trial booked from the website; billing plan choice still open.",
                -3,
                "grace",
            ),
            (
                "ava-lead",
                "Ava",
                "Martinez",
                "rosa.martinez@example.test",
                "(555) 241-0103",
                "referral",
                "enrolled",
                "Brazilian Jiu-Jitsu Core",
                True,
                "Rosa Martinez",
                "rosa.martinez@example.test",
                "(555) 241-0103",
                None,
                None,
                "Converted after a referral trial; useful for lead-to-student history.",
                -40,
                "ava",
            ),
            (
                "sebastian",
                "Sebastian",
                "Reed",
                "sebastian.reed@example.test",
                "(555) 241-0123",
                "social",
                "inquiry",
                "Tae Kwon Do Fundamentals",
                False,
                None,
                None,
                None,
                self._date(0),
                None,
                "Asked whether adult beginners can start mid-month.",
                -2,
                None,
            ),
            (
                "hazel",
                "Hazel",
                "Wright",
                "hazel.wright@example.test",
                "(555) 241-0124",
                "walk_in",
                "offer_sent",
                "Brazilian Jiu-Jitsu Core",
                True,
                "Monica Wright",
                "monica.wright@example.test",
                "(555) 241-0125",
                self._date(2),
                None,
                "Sibling discount quote sent after family class visit.",
                -6,
                None,
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
            converted_student_key,
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
                    "converted_student_id": student_ids.get(converted_student_key) if converted_student_key else None,
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
            if stage in {"trial_scheduled", "trial_completed", "offer_sent", "enrolled"}:
                activity_rows.append(
                    {
                        "id": self._id(studio_id, f"lead-activity:{key}:stage"),
                        "studio_id": studio_id,
                        "lead_id": lead_id,
                        "activity_type": "stage_change",
                        "description": f"Moved to {stage.replace('_', ' ')}.",
                        "created_by": actor_id,
                        "created_at": self._timestamp(created_offset + 1, 11, 15),
                    }
                )
            if follow_up and stage not in {"enrolled", "closed_lost"}:
                activity_rows.append(
                    {
                        "id": self._id(studio_id, f"lead-activity:{key}:follow-up"),
                        "studio_id": studio_id,
                        "lead_id": lead_id,
                        "activity_type": "follow_up",
                        "description": f"Follow up scheduled for {follow_up}.",
                        "created_by": actor_id,
                        "created_at": self._timestamp(created_offset + 1, 12),
                    }
                )
        self._insert("leads", lead_rows)
        self._insert("lead_activities", activity_rows)
