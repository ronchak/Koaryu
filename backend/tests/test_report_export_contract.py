import json
import unittest
from dataclasses import FrozenInstanceError
from datetime import date
from pathlib import Path

from fastapi import HTTPException

from app.services.report_export_catalog import (
    build_complete_report_catalog,
    build_report_catalog,
)
from app.services.report_export_catalog_types import REPORT_SOURCE_SPECS
from app.services.report_export_service import ReportExportService


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "report_exports"
EXPECTED_MANIFEST = json.loads(
    (FIXTURE_DIR / "catalog_manifest.json").read_text(encoding="utf-8")
)
INTELLIGENCE_FIXTURE = json.loads(
    (FIXTURE_DIR / "intelligence_fixture.json").read_text(encoding="utf-8")
)
EXPECTED_INTELLIGENCE_CSV = json.loads(
    (FIXTURE_DIR / "intelligence_expected_csv.json").read_text(encoding="utf-8")
)
EXPECTED_HEADERS = json.loads(
    (FIXTURE_DIR / "catalog_headers.json").read_text(encoding="utf-8")
)
EXPECTED_SOURCE_VOCABULARY = json.loads(
    (FIXTURE_DIR / "source_vocabulary.json").read_text(encoding="utf-8")
)


def report_snapshot(report):
    return {
        "id": report.id,
        "title": report.title,
        "filename": report.filename,
        "columns": list(report.columns),
        "table": report.table,
        "custom_builder": report.custom_builder.__name__ if report.custom_builder else None,
        "order_by": [list(item) for item in report.order_by],
        "min_role": report.min_role,
        "contains_sensitive_data": report.contains_sensitive_data,
        "availability": report.availability,
        "source_keys": list(report.source_keys),
    }


def source_snapshot(spec):
    return {
        "key": spec.key,
        "provider": spec.provider,
        "relation": spec.relation,
    }


class ReportExportContractTest(unittest.TestCase):
    def test_source_vocabulary_resolves_every_catalog_key_once(self):
        complete = build_complete_report_catalog(ReportExportService)
        catalog_source_keys = {
            source_key
            for report in complete.values()
            for source_key in report.source_keys
        }
        vocabulary_keys = set(REPORT_SOURCE_SPECS)
        expected_keys = {entry["key"] for entry in EXPECTED_SOURCE_VOCABULARY}

        self.assertEqual(expected_keys, catalog_source_keys)
        self.assertEqual(catalog_source_keys - vocabulary_keys, set())
        self.assertEqual(vocabulary_keys - catalog_source_keys, set())
        self.assertEqual(
            EXPECTED_SOURCE_VOCABULARY,
            [source_snapshot(REPORT_SOURCE_SPECS[key]) for key in sorted(REPORT_SOURCE_SPECS)],
        )
        self.assertEqual(
            {"postgrest", "auth_admin"},
            {spec.provider for spec in REPORT_SOURCE_SPECS.values()},
        )
        self.assertTrue(
            all(spec.key == key for key, spec in REPORT_SOURCE_SPECS.items())
        )

        with self.assertRaises(TypeError):
            REPORT_SOURCE_SPECS["students"] = REPORT_SOURCE_SPECS["students"]
        with self.assertRaises(FrozenInstanceError):
            REPORT_SOURCE_SPECS["students"].relation = "other_relation"

    def test_complete_manifest_is_explicit_and_live_catalog_stays_filtered(self):
        complete = build_complete_report_catalog(ReportExportService)
        live = build_report_catalog(ReportExportService)

        self.assertEqual(
            [entry["id"] for entry in EXPECTED_MANIFEST],
            list(complete),
        )
        self.assertEqual(
            EXPECTED_MANIFEST,
            [report_snapshot(report) for report in complete.values()],
        )
        self.assertTrue(all(isinstance(report.source_keys, tuple) for report in complete.values()))
        self.assertEqual(
            [entry["id"] for entry in EXPECTED_MANIFEST if entry["availability"] == "available"],
            list(live),
        )
        self.assertEqual(29, len(live))
        self.assertEqual(11, len(complete) - len(live))

        service = ReportExportService(None)
        for entry in EXPECTED_MANIFEST:
            if entry["availability"] == "deferred_billing":
                with self.subTest(report_id=entry["id"]):
                    with self.assertRaises(HTTPException) as context:
                        service.get_report(entry["id"])
                    self.assertEqual(404, context.exception.status_code)

    def test_every_live_header_is_an_exact_crlf_utf8_byte_golden(self):
        live = build_report_catalog(ReportExportService)
        expected_live = [
            entry for entry in EXPECTED_MANIFEST if entry["availability"] == "available"
        ]

        for entry in expected_live:
            with self.subTest(report_id=entry["id"]):
                report = live[entry["id"]]
                expected_header = EXPECTED_HEADERS[entry["id"]].encode("utf-8")
                actual_header = ReportExportService(None)._write_csv(report.columns, []).encode(
                    "utf-8"
                )
                self.assertEqual(entry["filename"], report.filename)
                self.assertEqual(expected_header, actual_header)
                self.assertTrue(actual_header.endswith(b"\r\n"))
                self.assertFalse(actual_header.startswith(b"\xef\xbb\xbf"))

    def test_intelligence_formula_bytes_are_exact_goldens(self):
        intelligence_ids = (
            "owner_kpi_summary",
            "quiet_churn_watchlist",
            "first_90_days_onboarding",
            "lead_quality_after_enrollment",
            "belt_momentum_testing_pipeline",
            "revenue_leakage",
            "schedule_utilization_demand",
            "family_account_health",
            "lifecycle_segmentation",
            "instructor_staff_impact",
            "data_hygiene_readiness",
        )
        self.assertEqual(intelligence_ids, tuple(EXPECTED_INTELLIGENCE_CSV))
        service = ReportExportService(None, today=date(2026, 6, 1))
        service._fetch_intelligence_dataset = lambda studio_id: INTELLIGENCE_FIXTURE

        for report_id, expected_csv in EXPECTED_INTELLIGENCE_CSV.items():
            with self.subTest(report_id=report_id):
                report = build_report_catalog(ReportExportService)[report_id]
                rows = report.custom_builder(service, "studio-1")
                actual = service._write_csv(report.columns, rows).encode("utf-8")
                self.assertEqual(expected_csv.encode("utf-8"), actual)
                self.assertTrue(actual.endswith(b"\r\n"))
                self.assertFalse(actual.startswith(b"\xef\xbb\xbf"))

    def test_formula_fixture_keeps_canceled_and_missing_session_semantics(self):
        self.assertIn(
            {"id": "attendance-canceled", "session_id": "session-canceled", "student_id": "student-2", "status": "present", "checked_in_at": "2026-05-29T18:00:00Z"},
            INTELLIGENCE_FIXTURE["attendance"],
        )
        self.assertIn(
            {"id": "attendance-missing-session", "session_id": "session-does-not-exist", "student_id": "student-1", "status": "present", "checked_in_at": "2026-05-28T18:00:00Z"},
            INTELLIGENCE_FIXTURE["attendance"],
        )
        self.assertIn("visits_30_days,3,", EXPECTED_INTELLIGENCE_CSV["owner_kpi_summary"])
        self.assertIn(",2026-05-29,3,1,1,0,1,past_due,", EXPECTED_INTELLIGENCE_CSV["quiet_churn_watchlist"])
        self.assertIn(",2,1,2,20,2,2,2,0,2.0,", EXPECTED_INTELLIGENCE_CSV["schedule_utilization_demand"])

    def test_csv_byte_contract_covers_special_values_and_injection_prefixes(self):
        columns = (
            "comma", "quote", "lf", "crlf", "unicode", "null", "true", "false",
            "nested", "equals", "plus", "minus", "at", "tab", "cr",
        )
        row = {
            "comma": "a,b",
            "quote": 'say "hi"',
            "lf": "line1\nline2",
            "crlf": "line1\r\nline2",
            "unicode": "東京 🚀",
            "null": None,
            "true": True,
            "false": False,
            "nested": {"z": "last", "a": [2, 1]},
            "equals": "=SUM(A1)",
            "plus": "+formula",
            "minus": "-formula",
            "at": "@formula",
            "tab": "\tformula",
            "cr": "\rformula",
        }
        expected = (
            'comma,quote,lf,crlf,unicode,null,true,false,nested,equals,plus,minus,at,tab,cr\r\n'
            '"a,b","say ""hi""","line1\nline2","line1\r\nline2",東京 🚀,,true,false,'
            '"{""a"": [2, 1], ""z"": ""last""}",\'=SUM(A1),\'+formula,\'-formula,'
            '\'@formula,\'\tformula,"\'\rformula"\r\n'
        ).encode("utf-8")

        actual = ReportExportService(None)._write_csv(columns, [row]).encode("utf-8")
        self.assertEqual(expected, actual)
        self.assertIn(b"\r\n", actual)
        self.assertNotIn(b"\xef\xbb\xbf", actual)


if __name__ == "__main__":
    unittest.main()
