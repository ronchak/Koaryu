import asyncio
import unittest
from pathlib import Path

from fastapi import HTTPException

from app.api.v1.endpoints.students import read_csv_import_upload
from app.schemas.student import CsvImportOptions
from app.services.student_import_csv import (
    CSV_IMPORT_MAX_BYTES,
    CSV_IMPORT_MAX_ROWS,
)
from app.services.student_import_planner import StudentImportPlanner
from app.services.student_service import (
    StudentService,
)


class FakeUploadFile:
    def __init__(self, content: bytes):
        self.content = content

    async def read(self, size: int = -1):
        if size is None or size < 0:
            return self.content
        return self.content[:size]


class StudentImportCsvParsingTests(unittest.TestCase):
    def setUp(self):
        self.service = StudentService(None)
        self.planner = StudentImportPlanner(None)

    def test_parse_csv_accepts_quoted_commas_and_cp1252_exports(self):
        content = "First Name,Last Name,Notes\nJosé,Álvarez,\"likes forms, sparring\"\n".encode("cp1252")

        headers, rows = self.service.parse_csv(content)

        self.assertEqual(headers, ["First Name", "Last Name", "Notes"])
        self.assertEqual(rows[0]["First Name"], "José")
        self.assertEqual(rows[0]["Notes"], "likes forms, sparring")

    def test_parse_csv_rejects_empty_uploads(self):
        with self.assertRaises(HTTPException) as raised:
            self.service.parse_csv(b"")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("header row", raised.exception.detail)

    def test_parse_csv_rejects_header_only_files(self):
        with self.assertRaises(HTTPException) as raised:
            self.service.parse_csv(b"First Name,Last Name\n")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("student rows", raised.exception.detail)

    def test_parse_csv_rejects_duplicate_headers_before_mapping_can_lose_data(self):
        with self.assertRaises(HTTPException) as raised:
            self.service.parse_csv(b"First Name,Last Name,first name\nAva,Nguyen,A\n")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("Duplicate CSV header", raised.exception.detail)

    def test_parse_csv_rejects_duplicate_normalized_headers(self):
        with self.assertRaises(HTTPException) as raised:
            self.service.parse_csv(b"First Name,Last Name,first_name\nAva,Nguyen,A\n")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("Duplicate CSV header", raised.exception.detail)

    def test_parse_csv_rejects_rows_with_extra_cells(self):
        with self.assertRaises(HTTPException) as raised:
            self.service.parse_csv(b"First Name,Last Name\nAva,Nguyen,extra\n")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("more values than the header row", raised.exception.detail)

    def test_parse_csv_treats_missing_trailing_cells_as_blank(self):
        headers, rows = self.service.parse_csv(b"First Name,Last Name,Status\nAva,Nguyen\n")

        self.assertEqual(headers, ["First Name", "Last Name", "Status"])
        self.assertEqual(rows[0]["Status"], "")

    def test_parse_csv_rejects_malformed_quotes_with_actionable_message(self):
        with self.assertRaises(HTTPException) as raised:
            self.service.parse_csv(b'First Name,Last Name\n"Ava,Nguyen\n')

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("unclosed quote", raised.exception.detail)

    def test_parse_csv_rejects_files_over_row_limit(self):
        lines = ["First Name,Last Name"]
        lines.extend(f"Student{i},Example" for i in range(CSV_IMPORT_MAX_ROWS + 1))

        with self.assertRaises(HTTPException) as raised:
            self.service.parse_csv(("\n".join(lines) + "\n").encode("utf-8"))

        self.assertEqual(raised.exception.status_code, 413)
        self.assertIn(str(CSV_IMPORT_MAX_ROWS), raised.exception.detail)

    def test_date_parser_accepts_month_names_and_excel_serial_dates(self):
        parsed_month, month_error = self.planner.parse_import_date("May 6, 2018", "date of birth")
        parsed_serial, serial_error = self.planner.parse_import_date("45123", "membership start date")
        parsed_dotted, dotted_error = self.planner.parse_import_date("07.23.2015", "date of birth")

        self.assertIsNone(month_error)
        self.assertEqual(parsed_month, "2018-05-06")
        self.assertIsNone(serial_error)
        self.assertEqual(parsed_serial, "2023-07-16")
        self.assertIsNone(dotted_error)
        self.assertEqual(parsed_dotted, "2015-07-23")

    def test_date_parser_rejects_year_only_values_instead_of_excel_serializing_them(self):
        parsed_date, date_error = self.planner.parse_import_date("2018", "date of birth")

        self.assertIsNone(parsed_date)
        self.assertIn("Invalid date of birth", date_error)

    def test_validate_import_rows_reports_required_field_errors_without_database_setup(self):
        result = self.service.validate_import_rows(
            [{"First Name": "Ava", "Last Name": "", "Status": "overdue"}],
            {"First Name": "legal_first_name", "Last Name": "legal_last_name", "Status": "status"},
            CsvImportOptions(),
            studio_id=None,
        )

        self.assertEqual(result.total_rows, 1)
        self.assertEqual(result.valid_rows, 0)
        self.assertEqual(result.error_rows, 1)
        self.assertEqual(result.rows[0].row_number, 2)
        self.assertTrue(any(issue.code == "missing_last_name" for issue in result.rows[0].issues))
        self.assertTrue(any(issue.code == "normalized_status" for issue in result.rows[0].issues))

    def test_validate_import_rows_rejects_duplicate_target_mappings(self):
        with self.assertRaises(HTTPException) as raised:
            self.service.validate_import_rows(
                [{"First Name": "Ava", "Legal First": "Override", "Last Name": "Nguyen"}],
                {
                    "First Name": "legal_first_name",
                    "Legal First": "legal_first_name",
                    "Last Name": "legal_last_name",
                },
                CsvImportOptions(),
                studio_id=None,
            )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("maps both", raised.exception.detail)

    def test_auto_map_keeps_payment_status_out_of_student_status(self):
        mapping = self.service.auto_map_headers([
            "Membership Status",
            "Payment Status",
            "PaymentStatus",
            "Billing Status",
            "BillingStatus",
            "Subscription Status",
            "SubscriptionStatus",
            "Autopay Status",
            "AutopayStatus",
            "Rank",
            "Rank/Belt",
            "Given",
            "Child",
            "Full Student Name",
        ])

        self.assertEqual(mapping["Membership Status"], "status")
        self.assertEqual(mapping["Payment Status"], "")
        self.assertEqual(mapping["PaymentStatus"], "")
        self.assertEqual(mapping["Billing Status"], "")
        self.assertEqual(mapping["BillingStatus"], "")
        self.assertEqual(mapping["Subscription Status"], "")
        self.assertEqual(mapping["SubscriptionStatus"], "")
        self.assertEqual(mapping["Autopay Status"], "")
        self.assertEqual(mapping["AutopayStatus"], "")
        self.assertEqual(mapping["Rank"], "current_belt_rank_id")
        self.assertEqual(mapping["Rank/Belt"], "current_belt_rank_id")
        self.assertEqual(mapping["Given"], "legal_first_name")
        self.assertEqual(mapping["Child"], "legal_first_name")
        self.assertEqual(mapping["Full Student Name"], "full_name")

    def test_validate_import_rows_rejects_manual_payment_status_mapping(self):
        for header in (
            "Payment Status",
            "PaymentStatus",
            "Billing Status",
            "BillingStatus",
            "Tuition Status",
            "Subscription Status",
            "SubscriptionStatus",
            "Autopay Status",
            "AutopayStatus",
        ):
            with self.subTest(header=header), self.assertRaises(HTTPException) as raised:
                self.service.validate_import_rows(
                    [{"First Name": "Ava", "Last Name": "Nguyen", header: "Current"}],
                    {"First Name": "legal_first_name", "Last Name": "legal_last_name", header: "status"},
                    CsvImportOptions(),
                    studio_id=None,
                )

            self.assertEqual(raised.exception.status_code, 400)
            self.assertIn("billing/payment data", raised.exception.detail)

    def test_full_name_splits_into_required_first_and_last_names(self):
        result = self.service.validate_import_rows(
            [
                {"Full Student Name": "Aiden \"AJ\" Morales"},
                {"Full Student Name": "Nguyen, Ava"},
                {"Full Student Name": "Ana Maria de la Cruz"},
                {"Full Student Name": "Sofia St. James"},
                {"Full Student Name": "John Smith Jr."},
            ],
            {"Full Student Name": "full_name"},
            CsvImportOptions(),
            studio_id=None,
        )

        self.assertEqual(result.valid_rows, 5)
        _, planned_rows = self.planner.prepare_import(
            [
                {"Full Student Name": "Aiden \"AJ\" Morales"},
                {"Full Student Name": "Nguyen, Ava"},
                {"Full Student Name": "Ana Maria de la Cruz"},
                {"Full Student Name": "Sofia St. James"},
                {"Full Student Name": "John Smith Jr."},
            ],
            {"Full Student Name": "full_name"},
            None,
            CsvImportOptions(),
        )
        self.assertEqual(planned_rows[0]["data"]["legal_first_name"], 'Aiden "AJ"')
        self.assertEqual(planned_rows[0]["data"]["legal_last_name"], "Morales")
        self.assertEqual(planned_rows[1]["data"]["legal_first_name"], "Ava")
        self.assertEqual(planned_rows[1]["data"]["legal_last_name"], "Nguyen")
        self.assertEqual(planned_rows[2]["data"]["legal_first_name"], "Ana Maria")
        self.assertEqual(planned_rows[2]["data"]["legal_last_name"], "de la Cruz")
        self.assertEqual(planned_rows[3]["data"]["legal_first_name"], "Sofia")
        self.assertEqual(planned_rows[3]["data"]["legal_last_name"], "St. James")
        self.assertEqual(planned_rows[4]["data"]["legal_first_name"], "John")
        self.assertEqual(planned_rows[4]["data"]["legal_last_name"], "Smith Jr.")

    def test_status_aliases_match_common_studio_owner_language(self):
        result = self.service.validate_import_rows(
            [
                {"First Name": "Ava", "Last Name": "Nguyen", "Status": "trial"},
                {"First Name": "Ben", "Last Name": "Lee", "Status": "current"},
                {"First Name": "Cora", "Last Name": "Diaz", "Status": "frozen"},
                {"First Name": "Dev", "Last Name": "Patel", "Status": "on hold"},
            ],
            {"First Name": "legal_first_name", "Last Name": "legal_last_name", "Status": "status"},
            CsvImportOptions(),
            studio_id=None,
        )

        self.assertEqual(result.valid_rows, 4)
        self.assertEqual(result.error_rows, 0)
        self.assertEqual(result.normalized_status_count, 4)
        self.assertEqual(
            {issue.value for row in result.rows for issue in row.issues if issue.code == "normalized_status"},
            {"trial", "current", "frozen", "on hold"},
        )

    def test_duplicate_notes_columns_are_combined_instead_of_rejected(self):
        result = self.service.validate_import_rows(
            [{
                "First Name": "Ava",
                "Last Name": "Nguyen",
                "Medical Notes": "Asthma inhaler in bag",
                "Instructor Notes": "Working on focus",
            }],
            {
                "First Name": "legal_first_name",
                "Last Name": "legal_last_name",
                "Medical Notes": "notes",
                "Instructor Notes": "notes",
            },
            CsvImportOptions(),
            studio_id=None,
        )

        self.assertEqual(result.valid_rows, 1)
        _, planned_rows = self.planner.prepare_import(
            [{
                "First Name": "Ava",
                "Last Name": "Nguyen",
                "Medical Notes": "Asthma inhaler in bag",
                "Instructor Notes": "Working on focus",
            }],
            {
                "First Name": "legal_first_name",
                "Last Name": "legal_last_name",
                "Medical Notes": "notes",
                "Instructor Notes": "notes",
            },
            None,
            CsvImportOptions(),
        )
        self.assertEqual(
            planned_rows[0]["data"]["notes"],
            "Medical Notes: Asthma inhaler in bag\nInstructor Notes: Working on focus",
        )

    def test_generated_owner_csv_fixtures_parse_and_validate_without_mapping_crashes(self):
        fixture_dir = Path(__file__).parent / "fixtures" / "csv_import"
        expected_min_valid_rows = {
            "studio_owner_a.csv": 32,
            "studio_owner_b.csv": 36,
            "studio_owner_c.csv": 34,
            "studio_owner_d.csv": 36,
            "studio_owner_e.csv": 32,
            "studio_owner_f.csv": 32,
            "stress_attendance_style.csv": 36,
            "stress_billing_style.csv": 35,
            "stress_family_style.csv": 36,
        }

        for file_name, minimum_valid_rows in expected_min_valid_rows.items():
            with self.subTest(file_name=file_name):
                headers, rows = self.service.parse_csv((fixture_dir / file_name).read_bytes())
                mapping = self.service.auto_map_headers(headers)
                result = self.service.validate_import_rows(rows, mapping, CsvImportOptions(), studio_id=None)

                self.assertGreaterEqual(result.valid_rows, minimum_valid_rows)
                self.assertEqual(result.total_rows, len(rows))
                self.assertNotIn("Payment Status", [header for header, field in mapping.items() if field == "status"])

    def test_pii_shaped_fixture_mappings_are_explicit_and_billing_columns_stay_skipped(self):
        fixture_dir = Path(__file__).parent / "fixtures" / "csv_import"
        expectations = {
            "stress_family_style.csv": {
                "mapped": {
                    "Child": "legal_first_name",
                    "Family Name": "legal_last_name",
                    "Guardian Full Name": "guardian_name",
                    "Guardian E-mail": "guardian_email",
                    "Mobile Phone": "phone",
                    "Address": "address_line1",
                    "City": "address_city",
                    "State": "address_state",
                    "Zip": "address_zip",
                    "Tags": "tags",
                },
                "skipped": {"Medical", "Coach Comments", "Plan", "Level", "Joined", "Preferred"},
            },
            "stress_billing_style.csv": {
                "mapped": {
                    "Full Student Name": "full_name",
                    "Program Track": "program_id",
                    "Belt/Rank": "current_belt_rank_id",
                    "Parent 1 Mobile": "guardian_phone",
                    "DOB": "date_of_birth",
                    "Emergency Contact": "emergency_contact_name",
                    "Notes": "notes",
                },
                "skipped": {"Subscription Status", "Payment Status", "Monthly Fee", "Last Paid", "Legacy Account #", "Parent 1"},
            },
            "stress_attendance_style.csv": {
                "mapped": {
                    "Given": "legal_first_name",
                    "Surname": "legal_last_name",
                    "Student Status": "status",
                    "Rank": "current_belt_rank_id",
                    "Emergency Name": "emergency_contact_name",
                    "Emergency Tel": "emergency_contact_phone",
                    "Parent Email": "guardian_email",
                    "DOB": "date_of_birth",
                    "Notes": "notes",
                },
                "skipped": {"Last Promoted", "Classes Last 30"},
            },
        }

        for file_name, expectation in expectations.items():
            with self.subTest(file_name=file_name):
                headers, rows = self.service.parse_csv((fixture_dir / file_name).read_bytes())
                mapping = self.service.auto_map_headers(headers)
                result = self.service.validate_import_rows(rows, mapping, CsvImportOptions(), studio_id=None)

                self.assertEqual(
                    {header: mapping[header] for header in expectation["mapped"]},
                    expectation["mapped"],
                )
                self.assertTrue(all(mapping[header] == "" for header in expectation["skipped"]))
                self.assertEqual(result.total_rows, len(rows))
                self.assertEqual(result.error_rows, 0)
                self.assertGreater(result.valid_rows, 0)

    def test_pii_shaped_fixture_import_plan_keeps_sensitive_columns_in_expected_fields(self):
        fixture_dir = Path(__file__).parent / "fixtures" / "csv_import"

        headers, family_rows = self.service.parse_csv((fixture_dir / "stress_family_style.csv").read_bytes())
        family_mapping = self.service.auto_map_headers(headers)
        _, family_plan = self.planner.prepare_import(family_rows, family_mapping, None, CsvImportOptions())
        family_data = family_plan[0]["data"]
        self.assertEqual(family_data["guardian_name"], "Marisol O'Neill")
        self.assertEqual(family_data["guardian_email"], "marisol.oneill@example.com")
        self.assertEqual(family_data["address_line1"], "18 Laurel St, Apt 4B")
        self.assertEqual(family_mapping["Medical"], "")
        self.assertNotIn("medical", family_data)
        self.assertEqual(family_mapping["Coach Comments"], "")
        self.assertNotIn("notes", family_data)

        headers, billing_rows = self.service.parse_csv((fixture_dir / "stress_billing_style.csv").read_bytes())
        billing_mapping = self.service.auto_map_headers(headers)
        _, billing_plan = self.planner.prepare_import(billing_rows, billing_mapping, None, CsvImportOptions())
        billing_data = billing_plan[0]["data"]
        self.assertEqual(billing_data["legal_first_name"], 'Aiden "AJ"')
        self.assertEqual(billing_data["legal_last_name"], "Morales")
        self.assertEqual(billing_data["guardian_phone"], "(415) 555-0198")
        self.assertEqual(billing_data["notes"], 'Needs pickup by 5:30, parent says "no late bus"')
        self.assertNotIn("status", billing_data)
        self.assertEqual(billing_mapping["Monthly Fee"], "")
        self.assertEqual(billing_mapping["Last Paid"], "")

        headers, attendance_rows = self.service.parse_csv((fixture_dir / "stress_attendance_style.csv").read_bytes())
        attendance_mapping = self.service.auto_map_headers(headers)
        attendance_result, attendance_plan = self.planner.prepare_import(
            attendance_rows,
            attendance_mapping,
            None,
            CsvImportOptions(),
        )
        attendance_data = attendance_plan[0]["data"]
        self.assertEqual(attendance_data["guardian_email"], "sofia.martinez@example.net")
        self.assertEqual(attendance_data["emergency_contact_phone"], "(415) 555-0188")
        self.assertEqual(attendance_data["date_of_birth"], "2014-06-03")
        self.assertEqual(attendance_result.normalized_status_count, len(attendance_rows))


class StudentImportUploadEndpointTests(unittest.TestCase):
    def test_upload_reader_rejects_oversized_files_before_full_parse(self):
        upload = FakeUploadFile(b"x" * (CSV_IMPORT_MAX_BYTES + 1))

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(read_csv_import_upload(upload))

        self.assertEqual(raised.exception.status_code, 413)
