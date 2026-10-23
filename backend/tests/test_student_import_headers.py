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

    def test_bare_parent_or_guardian_columns_hold_the_guardian_name(self):
        for header in (
            "Parent or Guardian",
            "Parent/Guardian",
            "Parent Guardian",
            "Primary Guardian",
            "Guardian",
            "Parent",
        ):
            with self.subTest(header=header):
                self.assertEqual(auto_map_csv_header(header), "guardian_name")
        # Descriptive guardian columns keep their specific fields.
        self.assertEqual(auto_map_csv_header("Parent or Guardian Email"), "guardian_email")
        self.assertEqual(auto_map_csv_header("Parent/Guardian Phone"), "guardian_phone")
        self.assertEqual(auto_map_csv_header("Parent Guardian Relationship"), "guardian_relation")
        self.assertEqual(auto_map_csv_header("Guardian Notes"), "notes")


def test_source_id_alias_priority_is_independent_of_order_and_preserves_other_headers():
    from app.services.student_import_headers import SOURCE_ID_ALIASES, auto_map_csv_headers

    ordinary = ["First Name", "Last Name", "Email", "Student Email", "Account Status", "Notes"]
    unchanged = {header: auto_map_csv_header(header) for header in ordinary}
    for index, selected in enumerate(SOURCE_ID_ALIASES):
        candidates = list(SOURCE_ID_ALIASES[index:])
        for headers in (ordinary + candidates, list(reversed(candidates)) + ordinary):
            mapping = auto_map_csv_headers(headers)
            assert {header: mapping[header] for header in ordinary} == unchanged
            assert mapping[selected] == "source_id"
            assert sum(target == "source_id" for target in mapping.values()) == 1
            assert all(mapping[header] == "" for header in candidates[1:])


def test_source_id_manual_mapping_trim_blank_and_length_validation():
    from app.services.student_import_headers import auto_map_csv_headers

    headers = ["First Name", "Last Name", "Member ID", "Student ID"]
    mapping = auto_map_csv_headers(headers)
    mapping.update({"Student ID": "", "Member ID": "source_id"})
    validate_csv_import_mapping(mapping, headers=headers)
    for value, expected, valid in [
        ("  00042  ", "00042", True),
        ("  ", None, True),
        ("x" * 120, "x" * 120, True),
        ("x" * 121, "x" * 121, False),
    ]:
        plan = build_import_row_plan(
            {"First Name": "Testava", "Last Name": "Fixturequill", "Member ID": value},
            mapping,
            options=CsvImportOptions(source_system="old-roster"),
        )
        assert plan["is_valid"] == valid
        assert plan["data"].get("source_id") == expected
        assert plan["data"].get("source_system") == ("old-roster" if expected else None)
        assert [issue.code for issue in plan["issues"]] == ([] if valid else ["source_id_too_long"])


def test_source_system_unset_is_effectively_csv_only_for_rows_with_ids():
    for source_id in ("00042", " "):
        plan = build_import_row_plan(
            {"First": "Ava", "Last": "Nguyen", "ID": source_id},
            {"First": "legal_first_name", "Last": "legal_last_name", "ID": "source_id"},
            options=CsvImportOptions(),
        )
        assert plan["is_valid"]
        assert plan["data"].get("source_system") == ("csv" if source_id.strip() else None)


def test_optional_source_system_retains_validation_when_set():
    import pytest
    from pydantic import ValidationError

    assert CsvImportOptions(source_system=None).source_system is None
    for value in ("", " ", "x" * 121):
        with pytest.raises(ValidationError):
            CsvImportOptions(source_system=value)
