import unittest

from pydantic import ValidationError

from app.schemas.schedule import ClassSessionCreate, ClassTemplateCreate, ClassTemplateUpdate


class ScheduleSchemaValidationTest(unittest.TestCase):
    def test_template_create_accepts_chronological_iso_schedule_values(self):
        template = ClassTemplateCreate(
            name="Evening Basics",
            day_of_week=2,
            start_time="09:00",
            end_time="10:00",
            start_date="2026-05-24",
            end_date="2026-05-31",
        )

        self.assertEqual(template.start_time, "09:00")
        self.assertEqual(template.end_date, "2026-05-31")

    def test_template_create_rejects_unpadded_time_before_comparing_strings(self):
        with self.assertRaises(ValidationError) as context:
            ClassTemplateCreate(
                name="Evening Basics",
                day_of_week=2,
                start_time="9:00",
                end_time="10:00",
                start_date="2026-05-24",
            )

        self.assertIn("Time must use HH:MM format", str(context.exception))

    def test_template_update_rejects_malformed_date(self):
        with self.assertRaises(ValidationError) as context:
            ClassTemplateUpdate(start_date="2026-5-24", end_date="2026-05-31")

        self.assertIn("Date must use YYYY-MM-DD format", str(context.exception))

    def test_template_update_rejects_compact_iso_date(self):
        with self.assertRaises(ValidationError) as context:
            ClassTemplateUpdate(start_date="20260524")

        self.assertIn("Date must use YYYY-MM-DD format", str(context.exception))

    def test_template_update_rejects_iso_week_date(self):
        with self.assertRaises(ValidationError) as context:
            ClassTemplateUpdate(start_date="2026-W21-7")

        self.assertIn("Date must use YYYY-MM-DD format", str(context.exception))

    def test_session_create_uses_parsed_time_for_ordering(self):
        with self.assertRaises(ValidationError) as context:
            ClassSessionCreate(
                name="Noon Session",
                date="2026-05-24",
                start_time="12:00",
                end_time="11:59",
            )

        self.assertIn("End time must be after start time", str(context.exception))

    def test_session_create_rejects_malformed_session_date(self):
        with self.assertRaises(ValidationError) as context:
            ClassSessionCreate(
                name="Noon Session",
                date="2026/05/24",
                start_time="11:00",
                end_time="12:00",
            )

        self.assertIn("Date must use YYYY-MM-DD format", str(context.exception))


if __name__ == "__main__":
    unittest.main()
