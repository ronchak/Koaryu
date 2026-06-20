import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  autoMap,
  buildCsvImportIssueGroups,
  buildPreflightSummary,
  buildPreviewValidationResult,
  formatRowNumbers,
  getCsvImportFileRejection,
  getKoaryuFieldLabel,
  getRowDisplayValue,
  getStudentImportStageIndex,
  getStudentImportErrorMessage,
  isPaymentStatusHeader,
  parseCsvText,
  pluralize,
} from "../src/lib/student-import-page-model.ts";
import { splitCsvImportFullName } from "../src/lib/csv-import-mapping.ts";

const DEFAULT_PREVIEW_OPTIONS = {
  create_missing_programs: false,
  create_missing_belts: false,
  import_without_unresolved_belt: true,
  status_alias_mode: "normalize",
};

function importResult(overrides = {}) {
  return {
    total_rows: 0,
    valid_rows: 0,
    error_rows: 0,
    rows: [],
    warnings: [],
    setup_issues: [],
    actions_available: {
      can_create_missing_programs: false,
      can_create_missing_belts: false,
      can_import_without_unresolved_belt: false,
    },
    created_programs: [],
    created_ladders: [],
    created_belts: [],
    imported_without_belt_count: 0,
    normalized_status_count: 0,
    imported_count: 0,
    ...overrides,
  };
}

describe("student import page model", () => {
  it("centralizes import workflow stage and file rejection rules", () => {
    assert.equal(getStudentImportStageIndex("upload"), 0);
    assert.equal(getStudentImportStageIndex("done"), 3);
    const limits = { maxBytes: 10 * 1024 * 1024, formattedLimit: "10 MB" };

    assert.equal(getCsvImportFileRejection({ name: "students.xlsx", size: 100 }, limits), "Please upload a .csv file.");
    assert.equal(
      getCsvImportFileRejection({ name: "students.csv", size: 11 * 1024 * 1024 }, limits),
      "This CSV is too large. Upload a file under 10 MB."
    );
    assert.equal(getCsvImportFileRejection({ name: "students.CSV", size: 100 }, limits), null);
  });

  it("auto-maps student identity fields while skipping payment status columns", () => {
    assert.deepEqual(
      autoMap(["Student Full Name", "Program Name", "Payment Status", "Guardian Mobile"]),
      {
        "Student Full Name": "full_name",
        "Program Name": "program_id",
        "Payment Status": "",
        "Guardian Mobile": "guardian_phone",
      }
    );
  });

  it("detects payment status headers without treating student status as billing", () => {
    assert.equal(isPaymentStatusHeader("AutoPayStatus"), true);
    assert.equal(isPaymentStatusHeader("Student Status"), false);
  });

  it("parses quoted commas, escaped quotes, and blank lines like the import preview", () => {
    assert.deepEqual(
      parseCsvText('Name,Notes\n"Ari Lane","Loves throws, sweeps"\n\n"Bo ""The Bear"" Kim",Ready\n'),
      [
        ["Name", "Notes"],
        ["Ari Lane", "Loves throws, sweeps"],
        ['Bo "The Bear" Kim', "Ready"],
      ]
    );
  });

  it("returns owner-facing labels for mapped Koaryu fields", () => {
    assert.equal(getKoaryuFieldLabel("guardian_email"), "Guardian Email");
    assert.equal(getKoaryuFieldLabel("unknown_field"), "unknown_field");
  });

  it("normalizes import errors for page messaging", () => {
    assert.equal(getStudentImportErrorMessage(new Error("CSV failed")), "CSV failed");
    assert.equal(
      getStudentImportErrorMessage(new Error("[object Object]", {
        cause: { msg: "Backend rejected row 4" },
      })),
      "Backend rejected row 4"
    );
    assert.equal(
      getStudentImportErrorMessage({ detail: "Upload is too large" }),
      "Upload is too large"
    );
    assert.equal(
      getStudentImportErrorMessage({ code: "unknown_failure" }),
      '{"code":"unknown_failure"}'
    );
    assert.equal(
      getStudentImportErrorMessage(null),
      "Something went wrong. Please try again."
    );
  });

  it("builds preview validation results with full-name splitting, notes merging, and status normalization", () => {
    const result = buildPreviewValidationResult(
      [
        {
          Name: "Lane, Ari",
          Status: "current",
          "Coach Notes": "Strong guard",
          "Office Notes": "Paid cash",
        },
        {
          Name: "Solo",
          Status: "mystery",
        },
      ],
      {
        Name: "full_name",
        Status: "status",
        "Coach Notes": "notes",
        "Office Notes": "notes",
      },
      DEFAULT_PREVIEW_OPTIONS,
      splitCsvImportFullName
    );

    assert.equal(result.total_rows, 2);
    assert.equal(result.valid_rows, 1);
    assert.equal(result.error_rows, 1);
    assert.equal(result.normalized_status_count, 1);
    assert.deepEqual(result.warnings[0].row_numbers, [2]);
    assert.equal(result.rows[0].data.legal_first_name, "Ari");
    assert.equal(result.rows[0].data.legal_last_name, "Lane");
    assert.equal(result.rows[0].data.status, "active");
    assert.equal(result.rows[0].data.notes, "Coach Notes: Strong guard\nOffice Notes: Paid cash");
    assert.deepEqual(
      result.rows[1].issues.map((issue) => issue.code),
      ["missing_last_name", "invalid_status"]
    );
  });

  it("summarizes import preflight state by setup, blocking, warning, and clean result priority", () => {
    assert.match(
      buildPreflightSummary(importResult({
        setup_issues: [{ code: "missing_belt_ladder" }],
        actions_available: { can_create_missing_belts: true },
      })),
      /create the missing program ladders/
    );
    assert.match(
      buildPreflightSummary(importResult({
        setup_issues: [{ code: "missing_belt" }],
        actions_available: { can_create_missing_belts: false },
      })),
      /preserve the original belt text/
    );
    assert.match(buildPreflightSummary(importResult({ setup_issues: [{ code: "ambiguous_belt_ladder" }] })), /more than one belt ladder/);
    assert.match(buildPreflightSummary(importResult({ setup_issues: [{ code: "missing_program" }] })), /create them during import/);
    assert.match(buildPreflightSummary(importResult({ error_rows: 1 })), /blocking issues/);
    assert.match(buildPreflightSummary(importResult({ warnings: [{ code: "normalized_status" }] })), /non-blocking warnings/);
    assert.equal(buildPreflightSummary(importResult()), "Your CSV looks ready to import.");
  });

  it("groups repeated row issues and formats row display helpers", () => {
    const groups = buildCsvImportIssueGroups(
      [
        {
          row_number: 4,
          data: { status: "current" },
          is_valid: true,
          issues: [{ code: "normalized_status", severity: "warning", field: "status", value: "current", message: "Normalized" }],
        },
        {
          row_number: 2,
          data: { status: "current" },
          is_valid: true,
          issues: [{ code: "normalized_status", severity: "warning", field: "status", value: "current", message: "Normalized" }],
        },
        {
          row_number: 3,
          data: { legal_last_name: "" },
          is_valid: false,
          issues: [{ code: "missing_last_name", severity: "error", field: "legal_last_name", message: "Missing last name" }],
        },
      ],
      "warning"
    );

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].rowNumbers, [4, 2]);
    assert.deepEqual(groups[0].mappedValues, ["current"]);
    assert.equal(getRowDisplayValue(["a", "b"]), "a, b");
    assert.equal(getRowDisplayValue(null), "—");
    assert.equal(formatRowNumbers([10, 2, 7, 1, 9, 3, 4, 6, 5]), "1, 2, 3, 4, 5, 6, 7, 9 + 1 more");
    assert.equal(pluralize(1, "student"), "student");
    assert.equal(pluralize(2, "student"), "students");
  });
});
