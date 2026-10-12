import unittest

from app.schemas.student import CsvImportOptions
from app.services.student_import_csv import validate_csv_import_mapping
from app.services.student_import_headers import auto_map_csv_header
from app.services.student_import_plan_rows import build_import_row_plan


class StudentImportHeaderTests(unittest.TestCase):
    def test_specific_name_fields_precede_generic_student_name_inference(self):
        cases = {
            "Student First Name": "legal_first_name",
            "Student First Name (Required)": "legal_first_name",
            "Student Last Name (Required)": "legal_last_name",
            "Student Given Name": "legal_first_name",
            "Student Family Name": "legal_last_name",
            "Preferred First Name": "preferred_name",
            "Preferred First Name (optional)": "preferred_name",
            "Student Preferred Name": "preferred_name",
            "Student Preferred First Name": "preferred_name",
            "Student Nick Name": "preferred_name",
            "Student Guardian Name": "guardian_name",
            "Student Emergency Contact Name": "emergency_contact_name",
            "Student Name": "full_name",
            "Full Student Name": "full_name",
            "Student Full Name (Required)": "full_name",
            "Full Name (First Last)": "full_name",
            "Full Name (Last, First)": "full_name",
            "Student Full Name (First and Last)": "full_name",
            "Student Name (Last, First)": "full_name",
            "Child Full Name": "full_name",
            "Child Last Name": "legal_last_name",
            "Child": "legal_first_name",
            "Given": "legal_first_name",
        }
        for header, expected in cases.items():
            with self.subTest(header=header):
                self.assertEqual(auto_map_csv_header(header), expected)

    def test_auto_mapped_preferred_name_survives_import_row_planning(self):
        row = {"First Name": "Alex", "Last Name": "Rivera", "Student Preferred Name": "Lex"}
        mapping = {header: auto_map_csv_header(header) for header in row}
        validate_csv_import_mapping(mapping, headers=list(row))

        plan = build_import_row_plan(row, mapping, options=CsvImportOptions())

        self.assertTrue(plan["is_valid"])
        self.assertEqual(plan["issues"], [])
        self.assertEqual(
            plan["data"],
            {"legal_first_name": "Alex", "legal_last_name": "Rivera", "preferred_name": "Lex"},
        )

    def test_auto_mapped_full_name_format_hints_preserve_name_splitting(self):
        for header, value in (
            ("Full Name (First Last)", "Alex Rivera"),
            ("Full Name (Last, First)", "Rivera, Alex"),
            ("Student Name (Last, First)", "Rivera, Alex"),
            ("Student Name (Surname, Given)", "Rivera, Alex"),
            ("Student Name (Surname, Forename)", "Rivera, Alex"),
            ("Student Name (Family, Given)", "Rivera, Alex"),
        ):
            with self.subTest(header=header):
                row = {header: value}
                mapping = {header: auto_map_csv_header(header)}
                plan = build_import_row_plan(row, mapping, options=CsvImportOptions())
                self.assertTrue(plan["is_valid"])
                self.assertEqual(plan["data"]["legal_first_name"], "Alex")
                self.assertEqual(plan["data"]["legal_last_name"], "Rivera")
