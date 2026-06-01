import unittest

from app.services.demo_student_seed import DemoStudentSeeder


class DemoStudentSeederTests(unittest.TestCase):
    def test_seed_students_builds_roster_and_related_rows(self):
        inserted: dict[str, list[dict]] = {}
        insert_order: list[str] = []

        def id_for(studio_id: str, key: str) -> str:
            return f"{studio_id}:{key}"

        def date_for(days_from_today: int) -> str:
            return f"date:{days_from_today}"

        def timestamp_for(days_from_today: int = 0, hour: int = 9, minute: int = 0) -> str:
            return f"ts:{days_from_today}:{hour}:{minute}"

        def insert(table: str, rows: list[dict]) -> None:
            insert_order.append(table)
            inserted[table] = rows

        def insert_optional(table: str, rows: list[dict]) -> None:
            insert_order.append(table)
            inserted[table] = rows

        program_ids = {
            "bjj_core": "program:bjj",
            "tae_kwon_do": "program:tkd",
        }
        rank_ids = {
            key: f"rank:{key}"
            for key in [
                "white",
                "white-stripe-1",
                "white-stripe-2",
                "white-stripe-3",
                "yellow",
                "orange",
                "green",
                "tkd-white",
                "tkd-yellow-stripe",
                "tkd-yellow",
                "tkd-green-stripe",
                "tkd-green",
                "tkd-blue-stripe",
                "tkd-blue",
            ]
        }

        student_ids = DemoStudentSeeder(
            id_for=id_for,
            date_for=date_for,
            timestamp_for=timestamp_for,
            insert=insert,
            insert_optional=insert_optional,
        ).seed_students("studio", program_ids, rank_ids)

        self.assertEqual(len(student_ids), 32)
        self.assertEqual(insert_order, ["students", "student_program_memberships", "guardians", "student_guardians"])
        self.assertEqual(set(inserted), {"students", "student_program_memberships", "guardians", "student_guardians"})
        self.assertEqual(len(inserted["students"]), 32)
        self.assertEqual(len(inserted["student_program_memberships"]), 34)
        self.assertEqual(len(inserted["guardians"]), 20)
        self.assertEqual(len(inserted["student_guardians"]), 20)

        aiko = next(row for row in inserted["students"] if row["id"] == student_ids["aiko"])
        self.assertEqual(aiko["legal_first_name"], "Aiko")
        self.assertEqual(aiko["program_id"], "program:bjj")
        self.assertEqual(aiko["current_belt_rank_id"], "rank:white-stripe-2")

        amara_memberships = [
            row
            for row in inserted["student_program_memberships"]
            if row["student_id"] == student_ids["amara"]
        ]
        self.assertEqual(len(amara_memberships), 2)
        self.assertEqual({row["program_id"] for row in amara_memberships}, {"program:bjj", "program:tkd"})


if __name__ == "__main__":
    unittest.main()
