"""Exercise all synthetic CSVs, independently of the future identity matcher.

Expected matcher interface:
    app.services.student_import_matching.match_rows(planned_rows, existing_roster)
        -> list[RowMatch]

Each RowMatch has duplicate_class, of_row, of_existing_key, reasons,
guardian_class, guardian_of_row, guardian_of_existing_key, guardian_reasons.
The duplicate fields describe the best overall match. When both sources match,
the manifest additionally retains in_file/existing evidence for auditing; those
extra objects are not part of this initial RowMatch interface.

Maintainers can capture fresh real pipeline snapshots, intentionally changing
truth, with `venv/bin/python tests/test_student_import_corpus.py --capture-oracle`
from backend/. Normal generation uses only stdlib and the committed snapshots;
tests never refresh expectations. No database, credentials or network is used.

Stored manifest rows are sparse. An absent row is valid with no error codes or
notes, no student duplicate, and a new guardian when a mapped guardian name is
present, otherwise no guardian. Expansion walks every row_number from 2 through
row_count + 1; absent rows receive the same live pipeline and matcher assertions.
Planner data is derived from authored fixture facts, never stored snapshots.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
CORPUS = BACKEND / "tests/fixtures/csv_import/corpus"
_generator_spec = importlib.util.spec_from_file_location(
    "csv_import_corpus_generator", CORPUS / "generate_corpus.py"
)
GENERATOR = importlib.util.module_from_spec(_generator_spec)
_generator_spec.loader.exec_module(GENERATOR)


def rejection_reason(exc):
    detail = str(exc.detail).lower()
    for fragment, reason in [
        ("too large", "too_large"),
        ("too many student rows", "too_many_rows"),
        ("too many columns", "too_many_columns"),
        ("duplicate csv header", "duplicate_header"),
        ("missing a header name", "missing_header_name"),
        ("more values than the header", "extra_cells"),
        ("unclosed quote", "malformed_quote"),
        ("does not include any student rows", "header_only"),
        ("header row", "empty"),
    ]:
        if fragment in detail:
            return "reject:" + reason
    raise AssertionError(f"Uncatalogued parser rejection: {exc.detail}")


def summarise_plan(plan, business_date):
    errors = [issue.code for issue in plan["issues"] if issue.severity == "error"]
    result = {
        "row_number": plan["row_number"],
        "valid": plan["is_valid"],
        "error_codes": errors,
    }
    dob = plan["data"].get("date_of_birth")
    if dob and "invalid_date_of_birth" not in errors and dob > business_date:
        result["notes"] = ["future_date_of_birth_if_business_date"]
    return result


def capture_oracle():
    """Authoring command only. Snapshot production code, not guessed behaviour."""
    import csv
    import io

    os.environ["ENVIRONMENT"] = "test"
    os.environ["SUPABASE_URL"] = "https://placeholder.supabase.co"
    sys.path.insert(0, str(BACKEND))
    from app.core.config import Settings

    Settings.model_config["env_file"] = None
    from fastapi import HTTPException

    from app.schemas.student import CsvImportOptions
    from app.services.student_import_csv import (
        decode_csv_import_content,
        validate_csv_import_mapping,
    )
    from app.services.student_import_planner import StudentImportPlanner
    from app.services.student_service import StudentService

    catalogue = GENERATOR.read_json(CORPUS / "scenarios.json")
    service, planner = StudentService(None), StudentImportPlanner(None)
    for spec in catalogue["files"]:
        content, _, _ = GENERATOR.content_for(spec, catalogue)
        raw_headers = (
            next(csv.reader(io.StringIO(decode_csv_import_content(content))), []) if content else []
        )
        auto_mapping = service.auto_map_headers([header.strip() for header in raw_headers])
        valid = True
        try:
            validate_csv_import_mapping(auto_mapping)
        except HTTPException as exc:
            assert exc.status_code == 400 and "maps both" in exc.detail, spec["id"]
            valid = False
        mapping = GENERATOR.corrected_mapping(auto_mapping, valid)
        validate_csv_import_mapping(mapping)
        oracle = {
            "parse": "ok",
            "auto_mapping": auto_mapping,
            "auto_mapping_valid": valid,
            "mapping": mapping,
            "rows": [],
        }
        if not valid:
            oracle["mapping_rejection"] = "duplicate_target"
        try:
            _, rows = service.parse_csv(content)
        except HTTPException as exc:
            oracle["parse"] = rejection_reason(exc)
        else:
            assert len(rows) == spec["row_count"], spec["id"]
            result, plans = planner.prepare_import(rows, mapping, None, CsvImportOptions())
            assert result.total_rows == spec["row_count"]
            oracle["rows"] = GENERATOR.compact_oracle_rows(
                [summarise_plan(plan, catalogue["business_date_for_notes"]) for plan in plans]
            )
        spec["oracle"] = oracle
    GENERATOR.write_json(CORPUS / "scenarios.json", catalogue)
    print(f"Captured real pipeline snapshots for {len(catalogue['files'])} files")


if __name__ == "__main__":
    if sys.argv[1:] != ["--capture-oracle"]:
        raise SystemExit("Use --capture-oracle, or run this module with pytest")
    capture_oracle()
    raise SystemExit(0)

# The authoring command above needs no pytest. Ordinary tests use repository
# conftest.py to disable .env and set the supported test environment.
import pytest
from fastapi import HTTPException

from app.schemas.student import CsvImportOptions
from app.services.student_import_csv import validate_csv_import_mapping
from app.services.student_import_plan_rows import build_import_row_plan
from app.services.student_import_planner import StudentImportPlanner
from app.services.student_service import StudentService

CATALOGUE = GENERATOR.read_json(CORPUS / "scenarios.json")
STORED_MANIFEST = GENERATOR.read_json(CORPUS / "manifest.json")
MANIFEST = GENERATOR.expand_manifest(STORED_MANIFEST, CATALOGUE)
ENTRIES = {entry["id"]: entry for entry in MANIFEST["files"]}
SPECS = {spec["id"]: spec for spec in CATALOGUE["files"]}
FULL = os.environ.get("KOARYU_CORPUS_FULL") == "1"
PARAMETERS = [
    pytest.param(
        entry,
        id=entry["id"],
        marks=pytest.mark.skipif(
            entry["slow"] and not FULL,
            reason="largest regenerated corpus file; set KOARYU_CORPUS_FULL=1",
        ),
    )
    for entry in MANIFEST["files"]
]


@pytest.fixture(scope="module", params=PARAMETERS)
def corpus_case(request, tmp_path_factory):
    entry = request.param
    root = CORPUS
    if not entry["materialized"]:
        root = tmp_path_factory.mktemp(entry["id"])
        subprocess.run(
            [
                sys.executable,
                "-I",
                str(CORPUS / "generate_corpus.py"),
                "--out",
                str(root),
                "--only",
                entry["id"],
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    content = (root / entry["path"]).read_bytes()
    assert len(content) == entry["byte_count"]
    assert hashlib.sha256(content).hexdigest() == entry["sha256"]
    return entry, content


def run_pipeline(entry, content):
    expected = entry["expected"]
    service = StudentService(None)
    if expected["parse"] != "ok":
        with pytest.raises(HTTPException) as caught:
            service.parse_csv(content)
        assert rejection_reason(caught.value) == expected["parse"]
        assert caught.value.status_code == (
            413
            if expected["parse"]
            in {"reject:too_large", "reject:too_many_rows", "reject:too_many_columns"}
            else 400
        )
        # Rejected files still have real-mapper expectations for their raw header.
        import csv
        import io

        from app.services.student_import_csv import decode_csv_import_content

        headers = (
            next(csv.reader(io.StringIO(decode_csv_import_content(content))), []) if content else []
        )
        headers = [header.strip() for header in headers]
        raw_rows = None
    else:
        headers, raw_rows = service.parse_csv(content)
        assert len(raw_rows) == entry["row_count"]
    auto_mapping = service.auto_map_headers(headers)
    assert auto_mapping == expected["auto_mapping"]
    if expected["auto_mapping_valid"]:
        validate_csv_import_mapping(auto_mapping)
        assert "mapping_rejection" not in expected
    else:
        assert expected["mapping_rejection"] == "duplicate_target"
        with pytest.raises(HTTPException) as caught:
            validate_csv_import_mapping(auto_mapping)
        assert caught.value.status_code == 400
        assert "maps both" in caught.value.detail
    mapping = GENERATOR.corrected_mapping(auto_mapping, expected["auto_mapping_valid"])
    assert mapping == expected["mapping"]
    validate_csv_import_mapping(mapping)
    if raw_rows is None:
        assert expected["rows"] == []
        return None
    result = service.validate_import_rows(raw_rows, mapping, CsvImportOptions(), studio_id=None)
    _, planned = StudentImportPlanner(None).prepare_import(
        raw_rows, mapping, None, CsvImportOptions()
    )
    assert result.total_rows == entry["row_count"]
    assert result.valid_rows == sum(row["valid"] for row in expected["rows"])
    assert result.error_rows == sum(not row["valid"] for row in expected["rows"])
    assert len(planned) == len(expected["rows"])
    # Result.rows contains only issue-bearing rows; the planner contains every row.
    actual = [summarise_plan(row, MANIFEST["business_date_for_notes"]) for row in planned]
    assert actual == GENERATOR.oracle_rows(SPECS[entry["id"]])
    assert [row["data"] for row in planned] == GENERATOR.truth_data_for(
        SPECS[entry["id"]], CATALOGUE
    )
    for plan, label in zip(actual, expected["rows"], strict=True):
        for key in ("row_number", "valid", "error_codes"):
            assert plan[key] == label[key]
        assert plan.get("notes", []) == label.get("notes", [])
    return planned


# Module fixture caching avoids parsing/planning a second time for matcher checks.
@pytest.fixture(scope="module")
def planned_case(corpus_case):
    entry, content = corpus_case
    return entry, run_pipeline(entry, content)


def test_corpus_pipeline(planned_case):
    entry, planned = planned_case
    assert (planned is not None) == (entry["expected"]["parse"] == "ok")


def assert_matcher_labels(planned_rows, existing_roster, expected_rows):
    """Only this function imports the optional production matcher."""
    try:
        from app.services.student_import_matching import match_rows
    except ModuleNotFoundError as exc:
        if exc.name != "app.services.student_import_matching":
            raise
        pytest.skip("duplicate matcher not present yet")
    if planned_rows is None:
        return  # Parser rejection has no rows to match.
    matches = match_rows(planned_rows, existing_roster)
    assert len(matches) == len(expected_rows)
    for match, label in zip(matches, expected_rows, strict=True):
        duplicate, guardian = label["duplicate"], label["guardian"]
        assert match.duplicate_class == duplicate["class"]
        assert match.of_row == duplicate["of_row"]
        assert match.of_existing_key == duplicate["of_existing"]
        assert list(match.reasons) == duplicate["reasons"]
        assert match.guardian_class == guardian["class"]
        assert match.guardian_of_row == guardian["of_row"]
        assert match.guardian_of_existing_key == guardian["of_existing"]
        assert list(match.guardian_reasons) == guardian["reasons"]


def test_corpus_matcher(planned_case):
    entry, planned = planned_case
    expected = entry["expected"]
    assert_matcher_labels(planned, expected["existing_roster"], expected["rows"])


def test_catalogue_coverage_and_budget():
    entries = MANIFEST["files"]
    assert MANIFEST["version"] == 1 and MANIFEST["synthetic"] is True
    assert len(entries) == 510 == len(SPECS)
    assert len(ENTRIES) == len(entries)
    assert len({e["dialect"] for e in entries}) == 12
    assert len([e for e in entries if e.get("pair_of")]) == 51
    assert sum(200 <= e["row_count"] <= 1000 for e in entries) >= 20
    assert sum(2000 <= e["row_count"] <= 9999 for e in entries) >= 6
    assert sum(e["row_count"] == 10000 for e in entries) == 1
    assert sum(e["row_count"] == 10001 for e in entries) == 1
    assert sum(e["byte_count"] > 10 * 1024 * 1024 for e in entries) == 1
    assert sum(e["slow"] for e in entries) == 3
    assert (
        sorted(e["byte_count"] for e in entries if e["slow"])
        == sorted(e["byte_count"] for e in entries if not e["materialized"])[-3:]
    )
    materialized = {e["path"] for e in entries if e["materialized"]}
    assert {f"files/{p.name}" for p in (CORPUS / "files").glob("*.csv")} == materialized
    assert sum((CORPUS / path).stat().st_size for path in materialized) < 8 * 1024 * 1024
    assert all(e["materialized"] == (e["byte_count"] <= 1024 * 1024) for e in entries)
    for entry in entries:
        variant = SPECS[entry["id"]].get("variant")
        required_rejection = {
            "empty": "empty",
            "header_only": "header_only",
            "duplicate_header": "duplicate_header",
            "missing_header_name": "missing_header_name",
            "extra_cells": "extra_cells",
            "malformed_quote": "malformed_quote",
            "too_large": "too_large",
            "too_many_columns": "too_many_columns",
        }.get(variant)
        if entry["row_count"] == 10001:
            required_rejection = "too_many_rows"
        assert entry["expected"]["parse"] == (
            "reject:" + required_rejection if required_rejection else "ok"
        )
        for header, target in entry["expected"]["auto_mapping"].items():
            if header in {
                "Student ID",
                "Member #",
                "Legacy Account #",
                "Monthly Tuition",
                "Payment Status",
                "Balance",
                "Last Attendance",
                "Classes Last 30",
            }:
                assert target == ""
    codes = {code for e in entries for row in e["expected"]["rows"] for code in row["error_codes"]}
    assert {
        "missing_first_name",
        "missing_last_name",
        "invalid_date_of_birth",
        "invalid_status",
    } <= codes
    assert "future_date_of_birth" not in codes
    labelled_rows = [row for entry in entries for row in entry["expected"]["rows"]]
    assert {row["duplicate"]["class"] for row in labelled_rows} == {
        "none",
        "in_file_strong",
        "in_file_possible",
        "existing_strong",
        "existing_possible",
        "different_person",
        "archived_match",
    }
    assert {row["guardian"]["class"] for row in labelled_rows} == {
        "none",
        "new",
        "link_existing",
        "in_file_shared",
        "separate_contact",
    }
    duplicate_email = ENTRIES["mapping_duplicate_email"]["expected"]
    guardian_parts = ENTRIES["mapping_separate_guardian_names"]["expected"]
    assert duplicate_email["mapping"] == {
        "First Name": "legal_first_name",
        "Last Name": "legal_last_name",
        "Email": "email",
        "Student Email": "",
    }
    assert guardian_parts["mapping"]["Guardian First Name"] == "guardian_name"
    assert guardian_parts["mapping"]["Guardian Last Name"] == ""


def test_identity_truth_controls():
    def row(variant, index=0):
        return ENTRIES[f"family_{variant}_01"]["expected"]["rows"][index]

    assert row("twins")["duplicate"]["class"] == "none"
    assert row("three_siblings", 1)["duplicate"]["class"] == "none"
    assert row("three_siblings", 1)["guardian"]["class"] == "in_file_shared"
    assert row("step_siblings", 1)["duplicate"]["class"] == "none"
    assert row("parent_child")["duplicate"]["class"] == "different_person"
    assert row("unrelated_same_name")["duplicate"]["class"] == "different_person"
    assert row("missing_dob")["duplicate"]["class"] == "existing_strong"
    assert row("repeated_formatting", 1)["duplicate"]["class"] == "in_file_strong"
    assert row("repeated_formatting", 1)["duplicate"]["of_row"] == 2
    assert row("repeated_formatting", 1)["duplicate"]["existing"]["class"] == "existing_strong"
    assert row("repeated_email", 1)["duplicate"]["class"] == "in_file_strong"
    assert row("archived_reappears")["duplicate"]["class"] == "archived_match"
    assert row("archived_reappears")["duplicate"]["reasons"][-1] == "strong"
    assert row("sibling_email", 1)["duplicate"]["class"] == "none"
    assert row("conflicting_dob_email")["duplicate"]["class"] == "existing_possible"
    assert row("guardian_spelling", 1)["guardian"]["reasons"] == ["email", "last_name"]
    assert (
        row("guardian_same_email_different_parents", 1)["guardian"]["class"] == "separate_contact"
    )
    assert row("guardian_no_email", 1)["guardian"]["reasons"] == ["name", "phone"]
    assert row("guardian_no_email", 2)["guardian"]["reasons"] == ["name"]
    assert row("guardian_placeholder", 1)["guardian"]["class"] == "separate_contact"
    assert row("staff_guardian", 1)["duplicate"]["class"] == "none"
    assert row("staff_guardian", 1)["guardian"]["class"] == "in_file_shared"
    controls = {
        entry["variant"]: entry["expected"]["rows"]
        for entry in MANIFEST["files"]
        if entry["scenario"] == "identity_controls"
    }
    assert controls["missing_dob_phone"][0]["duplicate"]["reasons"] == ["name", "phone"]
    assert controls["missing_dob_phone"][1]["duplicate"]["class"] == "existing_strong"
    assert controls["missing_dob_phone"][1]["duplicate"]["in_file"]["class"] == "in_file_possible"
    assert controls["missing_dob_name"][1]["duplicate"]["class"] == "in_file_possible"
    assert controls["missing_dob_name"][1]["duplicate"]["reasons"] == ["name"]
    assert controls["archived_possible"][0]["duplicate"]["reasons"] == ["name", "phone", "possible"]
    assert controls["guardian_link_name_phone"][0]["guardian"]["class"] == "link_existing"
    assert controls["guardian_link_name_phone"][0]["guardian"]["reasons"] == ["name", "phone"]
    assert controls["guardian_email_first"][0]["guardian"]["reasons"] == ["email", "first_name"]
    assert controls["preferred_no_identity"][0]["duplicate"]["class"] == "none"


def test_identity_normalization_contract():
    assert GENERATOR.name_key("Áva-Grace O'Neill III") == "avagraceoneill"
    assert GENERATOR.name_key("de la Véy") == "delavey"
    assert GENERATOR.name_key("van Lumen Jr.") == "vanlumen"
    assert GENERATOR.name_key("Quillfenjr") == "quillfenjr"
    assert GENERATOR.name_key("测试曦") == "测试曦"
    assert GENERATOR.name_key("Тестмира") == "тестмира"
    assert GENERATOR.name_key("Δοκιμήρα") == "δοκιμηρα"
    assert GENERATOR.name_key("تَجْرِيبَا") == GENERATOR.name_key("تجريبا") == "تجريبا"
    assert GENERATOR.name_key("تَـجْرِيبَا") == "تـجريبا"
    assert GENERATOR.name_key("تَـجْرِيبَا") != GENERATOR.name_key("تجريبا")
    assert GENERATOR.name_key("Testmira_虚构 Jr.") == "testmira虚构"
    assert GENERATOR.name_key("学生１２٣") == "学生12٣"
    assert GENERATOR.email_key("  SYNTHETIC@EXAMPLE.INVALID  ") == "synthetic@example.invalid"
    assert GENERATOR.email_key("  ") is None
    assert GENERATOR.phone_key("+1 (202) 555-0198") == "2025550198"
    assert GENERATOR.phone_key("555-0198") == "5550198"
    assert GENERATOR.phone_key("0198") is None


def test_script_family_truth_controls():
    scripts = [entry for entry in MANIFEST["files"] if entry["scenario"] == "family_scripts"]
    assert len(scripts) == 10
    assert len({entry["dialect"] for entry in scripts}) == 5

    def rows(variant):
        return ENTRIES["scripts_" + variant]["expected"]["rows"]

    for variant in ("cjk_in_file", "arabic_diacritics", "mixed_repeat"):
        duplicate = rows(variant)[1]["duplicate"]
        assert duplicate == {
            "class": "in_file_strong",
            "of_row": 2,
            "of_existing": None,
            "reasons": ["name", "date_of_birth"],
        }
    assert rows("cjk_in_file")[0]["guardian"]["class"] == "new"
    assert rows("cjk_existing")[0]["duplicate"]["class"] == "existing_strong"
    assert rows("cjk_existing")[0]["duplicate"]["of_existing"] == "s1"
    assert rows("cjk_existing")[0]["guardian"]["class"] == "link_existing"
    assert rows("cjk_existing")[0]["guardian"]["reasons"] == ["email", "first_name"]
    assert all(row["duplicate"]["class"] == "none" for row in rows("cyrillic_siblings"))
    assert rows("cyrillic_siblings")[1]["guardian"]["class"] == "in_file_shared"
    assert rows("greek_parent_child")[0]["duplicate"]["class"] == "different_person"
    assert rows("greek_parent_child")[0]["guardian"]["class"] == "separate_contact"
    assert rows("greek_parent_child")[0]["guardian"]["reasons"] == ["email", "name_mismatch"]
    assert all(row["duplicate"]["class"] == "none" for row in rows("arabic_tatweel"))
    assert all(row["duplicate"]["class"] == "none" for row in rows("transliteration_limit"))
    assert GENERATOR.name_key("测试曦") != GENERATOR.name_key("CeshiXi")
    reupload = ENTRIES["scripts_reupload_b"]
    assert reupload["pair_of"] == "scripts_reupload_a"
    assert reupload["expected"]["rows"][0]["duplicate"]["class"] == "existing_strong"
    assert len(reupload["expected"]["existing_roster"]) == 24


def test_reupload_rosters_are_imported_valid_a_rows():
    for entry in MANIFEST["files"]:
        if not entry.get("pair_of"):
            continue
        first = ENTRIES[entry["pair_of"]]
        _, content = first, (CORPUS / first["path"]).read_bytes()
        plans = run_pipeline(first, content)
        snapshots = [
            {**summarise_plan(plan, MANIFEST["business_date_for_notes"]), "data": plan["data"]}
            for plan in plans
        ]
        assert entry["expected"]["existing_roster"] == GENERATOR.imported_roster(snapshots)
        assert len(entry["expected"]["rows"]) == entry["row_count"]
        assert sum(row["duplicate"]["class"] == "none" for row in entry["expected"]["rows"]) == 2


def test_blank_lines_use_compacted_row_numbers_and_future_dates_need_business_date():
    entry = ENTRIES["framing_blank_rows"]
    headers, rows = StudentService(None).parse_csv((CORPUS / entry["path"]).read_bytes())
    assert len((CORPUS / entry["path"]).read_text().splitlines()) > entry["row_count"] + 1
    assert [r["row_number"] for r in entry["expected"]["rows"]] == list(range(2, len(rows) + 2))
    assert headers == list(entry["expected"]["auto_mapping"])
    mapping = entry["expected"]["mapping"]
    plans = [
        build_import_row_plan(
            row, mapping, options=CsvImportOptions(), business_date=date(2026, 10, 21)
        )
        for row in rows
    ]
    future = [
        i + 2
        for i, plan in enumerate(plans)
        if any(issue.code == "future_date_of_birth" for issue in plan["issues"])
    ]
    assert future == [row["row_number"] for row in entry["expected"]["rows"] if row.get("notes")]
    assert future


def test_materialized_bytes_reproduce_without_pipeline_dependencies():
    for entry in MANIFEST["files"]:
        if entry["materialized"]:
            content, _, _ = GENERATOR.content_for(SPECS[entry["id"]], CATALOGUE)
            assert content == (CORPUS / entry["path"]).read_bytes(), entry["id"]


def test_sparse_storage_preserves_every_row_and_bounds_json_size():
    documents = list(CORPUS.glob("*.json")) + list(CORPUS.glob("*.json.gz"))
    assert len(documents) == 2
    assert sum(path.stat().st_size for path in documents) <= 2_000_000
    omitted = 0
    for stored, expanded in zip(STORED_MANIFEST["files"], MANIFEST["files"], strict=True):
        rows = stored["expected"]["rows"]
        assert len({row["row_number"] for row in rows}) == len(rows)
        assert all(not GENERATOR.is_default_label(row) for row in rows)
        if stored["expected"]["parse"] == "ok":
            assert len(expanded["expected"]["rows"]) == stored["row_count"]
            explicit = {row["row_number"] for row in rows}
            for row in expanded["expected"]["rows"]:
                if row["row_number"] not in explicit:
                    assert GENERATOR.is_default_label(row)
                    omitted += 1
        for row in SPECS[stored["id"]]["oracle"]["rows"]:
            assert "data" not in row
    assert omitted > 30_000
