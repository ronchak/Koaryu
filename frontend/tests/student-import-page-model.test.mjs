import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  autoMap,
  buildCsvImportIssueGroups,
  buildDefaultDuplicateDecisions,
  buildDuplicateDecision,
  buildPreflightSummary,
  buildPreviewValidationResult,
  countDuplicateSkips,
  describeDuplicateCandidate,
  getDuplicateReviewRows,
  describeGuardianOutcome,
  getImportActionState,
  hasUnresolvedDuplicateDecisions,
  formatRowNumbers,
  getCsvImportFileRejection,
  getRowDisplayValue,
  getStudentImportStageIndex,
  getStudentImportErrorMessage,
  isPaymentStatusHeader,
  mockParseCSV,
  parseCsvText,
  pluralize,
} from "../src/lib/student-import-page-model.ts";
import { splitCsvImportFullName } from "../src/lib/csv-import-mapping.ts";
import { buildPreviewStudentImportResult } from "../src/lib/student-import-store-model.ts";

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

    assert.equal(
      getCsvImportFileRejection({ name: "students.xlsx", size: 100 }, limits),
      "Please upload a .csv file.",
    );
    assert.equal(
      getCsvImportFileRejection({ name: "students.csv", size: 11 * 1024 * 1024 }, limits),
      "This CSV is too large. Upload a file under 10 MB.",
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
      },
    );
  });

  it("prefers specific name fields over generic student-name inference", () => {
    const cases = [
      ["Student First Name", "legal_first_name"],
      ["Student First Name (Required)", "legal_first_name"],
      ["Student Last Name (Required)", "legal_last_name"],
      ["Student Given Name", "legal_first_name"],
      ["Student Family Name", "legal_last_name"],
      ["Preferred First Name", "preferred_name"],
      ["Preferred First Name (optional)", "preferred_name"],
      ["Student Preferred Name", "preferred_name"],
      ["Student Preferred First Name", "preferred_name"],
      ["Student Nick Name", "preferred_name"],
      ["Student Guardian Name", "guardian_name"],
      ["Student Emergency Contact Name", "emergency_contact_name"],
      ["Student Name", "full_name"],
      ["Full Student Name", "full_name"],
      ["Student Full Name (Required)", "full_name"],
      ["Full Name (First Last)", "full_name"],
      ["Full Name (Last, First)", "full_name"],
      ["Student Full Name (First and Last)", "full_name"],
      ["Student Name (Last, First)", "full_name"],
      ["Child Full Name", "full_name"],
      ["Child Last Name", "legal_last_name"],
      ["Child", "legal_first_name"],
      ["Given", "legal_first_name"],
    ];

    assert.deepEqual(autoMap(cases.map(([header]) => header)), Object.fromEntries(cases));
  });

  it("retains an auto-mapped student preferred name through preview import", () => {
    const row = { "First Name": "Alex", "Last Name": "Rivera", "Student Preferred Name": "Lex" };
    const execution = buildPreviewStudentImportResult({
      rows: [row],
      mapping: autoMap(Object.keys(row)),
      options: DEFAULT_PREVIEW_OPTIONS,
      programs: [],
      beltLadders: [],
      fallbackRanks: [],
      existingStudents: [],
      idFactory: () => "student-import-1",
      now: () => new Date("2026-10-09T00:00:00.000Z"),
      businessDate: "2026-10-09",
    });

    assert.equal(execution.result.imported_count, 1);
    assert.equal(execution.result.error_rows, 0);
    assert.deepEqual(execution.result.warnings, []);
    assert.equal(execution.importedStudents[0].legal_first_name, "Alex");
    assert.equal(execution.importedStudents[0].legal_last_name, "Rivera");
    assert.equal(execution.importedStudents[0].preferred_name, "Lex");
  });

  it("preserves full-name splitting when auto-mapped headers include format hints", () => {
    for (const [header, value] of [
      ["Full Name (First Last)", "Alex Rivera"],
      ["Full Name (Last, First)", "Rivera, Alex"],
      ["Student Name (Last, First)", "Rivera, Alex"],
      ["Student Name (Surname, Given)", "Rivera, Alex"],
      ["Student Name (Surname, Forename)", "Rivera, Alex"],
      ["Student Name (Family, Given)", "Rivera, Alex"],
    ]) {
      const execution = buildPreviewStudentImportResult({
        rows: [{ [header]: value }],
        mapping: autoMap([header]),
        options: DEFAULT_PREVIEW_OPTIONS,
        programs: [],
        beltLadders: [],
        fallbackRanks: [],
        existingStudents: [],
        idFactory: () => "student-import-1",
        now: () => new Date("2026-10-09T00:00:00.000Z"),
        businessDate: "2026-10-09",
      });
      assert.equal(execution.result.imported_count, 1, header);
      assert.equal(execution.importedStudents[0].legal_first_name, "Alex", header);
      assert.equal(execution.importedStudents[0].legal_last_name, "Rivera", header);
    }
  });

  it("detects payment status headers without treating student status as billing", () => {
    assert.equal(isPaymentStatusHeader("AutoPayStatus"), true);
    assert.equal(isPaymentStatusHeader("Student Status"), false);
  });

  it("parses valid CSV and rejects normalized duplicate headers through the FileReader promise", async () => {
    assert.deepEqual(
      parseCsvText(
        'Name,Notes\n"Ari Lane","Loves throws, sweeps"\n\n"Bo ""The Bear"" Kim",Ready\n',
      ),
      [
        ["Name", "Notes"],
        ["Ari Lane", "Loves throws, sweeps"],
        ['Bo "The Bear" Kim', "Ready"],
      ],
    );
    const previousFileReader = globalThis.FileReader;
    globalThis.FileReader = class {
      readAsText(file) {
        this.onload({ target: { result: file.contents } });
      }
    };
    try {
      assert.deepEqual(await mockParseCSV({ contents: "" }), { headers: [], rows: [] });
      assert.deepEqual(await mockParseCSV({ contents: 'Name,Notes\nAri,"Throws, sweeps"' }), {
        headers: ["Name", "Notes"],
        rows: [{ Name: "Ari", Notes: "Throws, sweeps" }],
      });
      await assert.rejects(
        mockParseCSV({ contents: "First Name, first-name \nAri,Lane" }),
        /Duplicate CSV header 'first-name'/,
      );
    } finally {
      globalThis.FileReader = previousFileReader;
    }
  });

  it("normalizes import errors for page messaging", () => {
    assert.equal(getStudentImportErrorMessage(new Error("CSV failed")), "CSV failed");
    assert.equal(
      getStudentImportErrorMessage(
        new Error("[object Object]", {
          cause: { msg: "Backend rejected row 4" },
        }),
      ),
      "Backend rejected row 4",
    );
    assert.equal(
      getStudentImportErrorMessage({ detail: "Upload is too large" }),
      "Upload is too large",
    );
    assert.equal(
      getStudentImportErrorMessage({ code: "unknown_failure" }),
      '{"code":"unknown_failure"}',
    );
    assert.equal(getStudentImportErrorMessage(null), "Something went wrong. Please try again.");
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
      splitCsvImportFullName,
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
      ["missing_last_name", "invalid_status"],
    );
  });

  it("summarizes import preflight state by setup, blocking, warning, and clean result priority", () => {
    assert.match(
      buildPreflightSummary(
        importResult({
          setup_issues: [{ code: "missing_belt_ladder" }],
          actions_available: { can_create_missing_belts: true },
        }),
      ),
      /create the missing program ladders/,
    );
    assert.match(
      buildPreflightSummary(
        importResult({
          setup_issues: [{ code: "missing_belt" }],
          actions_available: { can_create_missing_belts: false },
        }),
      ),
      /preserve the original belt text/,
    );
    assert.match(
      buildPreflightSummary(importResult({ setup_issues: [{ code: "ambiguous_belt_ladder" }] })),
      /more than one belt ladder/,
    );
    assert.match(
      buildPreflightSummary(importResult({ setup_issues: [{ code: "missing_program" }] })),
      /create them during import/,
    );
    assert.match(buildPreflightSummary(importResult({ error_rows: 1 })), /blocking issues/);
    assert.match(
      buildPreflightSummary(importResult({ warnings: [{ code: "normalized_status" }] })),
      /non-blocking warnings/,
    );
    assert.equal(buildPreflightSummary(importResult()), "Your CSV looks ready to import.");
  });

  it("groups repeated row issues and formats row display helpers", () => {
    const groups = buildCsvImportIssueGroups(
      [
        {
          row_number: 4,
          data: { status: "current" },
          is_valid: true,
          issues: [
            {
              code: "normalized_status",
              severity: "warning",
              field: "status",
              value: "current",
              message: "Normalized",
            },
          ],
        },
        {
          row_number: 2,
          data: { status: "current" },
          is_valid: true,
          issues: [
            {
              code: "normalized_status",
              severity: "warning",
              field: "status",
              value: "current",
              message: "Normalized",
            },
          ],
        },
        {
          row_number: 3,
          data: { legal_last_name: "" },
          is_valid: false,
          issues: [
            {
              code: "missing_last_name",
              severity: "error",
              field: "legal_last_name",
              message: "Missing last name",
            },
          ],
        },
      ],
      "warning",
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
  it("builds duplicate decisions from the review payload with explicit defaults", () => {
    const candidate = (overrides) => ({
      student_id: null,
      of_row: null,
      display_name: "Ava Nguyen",
      archived: false,
      confidence: "strong",
      reasons: ["same name", "same birth date"],
      ...overrides,
    });
    const review = (candidates, suggested_action) => ({
      candidates,
      suggested_action,
      family_context: [],
      acknowledge_student_ids: candidates
        .filter((c) => c.student_id && (c.confidence === "strong" || c.archived))
        .map((c) => c.student_id),
      acknowledge_rows: candidates
        .filter((c) => c.of_row != null && (c.confidence === "strong" || c.archived))
        .map((c) => c.of_row),
    });
    const result = importResult({
      valid_rows: 6,
      rows: [
        {
          row_number: 2,
          data: { legal_first_name: "Ava", legal_last_name: "Nguyen" },
          issues: [],
          is_valid: true,
          duplicate_review: review([candidate({ student_id: "s1" })], "skip"),
        },
        {
          row_number: 3,
          data: { legal_first_name: "Mina", legal_last_name: "Nguyen" },
          issues: [],
          is_valid: true,
          duplicate_review: review(
            [candidate({ student_id: "s2", archived: true, display_name: "Mina Nguyen" })],
            "decide",
          ),
        },
        {
          row_number: 4,
          data: { legal_first_name: "Leo", legal_last_name: "Nguyen" },
          issues: [],
          is_valid: true,
          duplicate_review: review(
            [candidate({ student_id: "s3", confidence: "possible", reasons: ["same name"] })],
            "create",
          ),
        },
        {
          row_number: 5,
          data: { legal_first_name: "Ava", legal_last_name: "Nguyen" },
          issues: [],
          is_valid: true,
          duplicate_review: review(
            [candidate({ of_row: 2 }), candidate({ student_id: "s1" })],
            "skip",
          ),
        },
        {
          row_number: 6,
          data: { legal_first_name: "Carlos", legal_last_name: "Reyes" },
          issues: [],
          is_valid: true,
          duplicate_review: review(
            [
              candidate({
                student_id: "s4",
                confidence: "different_person",
                reasons: ["same name", "different birth date"],
                display_name: "Carlos Reyes",
              }),
            ],
            "create",
          ),
        },
      ],
    });

    const rows = getDuplicateReviewRows(result);
    assert.deepEqual(
      rows.map((row) => [row.rowNumber, row.rowName, row.needsChoice, row.decisionRequired]),
      [
        [2, "Ava Nguyen", true, false],
        [3, "Mina Nguyen", true, true],
        [4, "Leo Nguyen", true, false],
        [5, "Ava Nguyen", true, false],
        [6, "Carlos Reyes", false, false],
      ],
    );

    const defaults = buildDefaultDuplicateDecisions(result);
    assert.deepEqual(defaults, {
      2: {
        action: "skip",
        matched_student_id: "s1",
        of_row: null,
        acknowledged_student_ids: ["s1"],
        acknowledged_rows: [],
      },
      4: {
        action: "create",
        matched_student_id: "s3",
        of_row: null,
        acknowledged_student_ids: [],
        acknowledged_rows: [],
      },
      5: {
        action: "skip",
        matched_student_id: "s1",
        of_row: 2,
        acknowledged_student_ids: ["s1"],
        acknowledged_rows: [2],
      },
    });
    assert.equal(hasUnresolvedDuplicateDecisions(result, defaults), true);
    assert.equal(countDuplicateSkips(result, defaults), 2);

    const resolved = {
      ...defaults,
      3: buildDuplicateDecision(rows[1].review, "create"),
    };
    assert.deepEqual(resolved[3], {
      action: "create",
      matched_student_id: "s2",
      of_row: null,
      acknowledged_student_ids: ["s2"],
      acknowledged_rows: [],
    });
    assert.equal(hasUnresolvedDuplicateDecisions(result, resolved), false);
    assert.equal(countDuplicateSkips(result, resolved), 2);
    assert.equal(
      describeDuplicateCandidate(candidate({ of_row: 2 })),
      "row 2, Ava Nguyen · same name, same birth date",
    );
    assert.equal(
      describeDuplicateCandidate(candidate({ student_id: "s1", reasons: [] })),
      "Ava Nguyen",
    );
  });
  it("maps bare parent or guardian columns to the guardian name", () => {
    assert.deepEqual(
      autoMap([
        "Parent or Guardian",
        "Parent/Guardian",
        "Parent Guardian",
        "Primary Guardian",
        "Parent or Guardian Email",
        "Parent/Guardian Phone",
        "Guardian Notes",
      ]),
      {
        "Parent or Guardian": "guardian_name",
        "Parent/Guardian": "guardian_name",
        "Parent Guardian": "guardian_name",
        "Primary Guardian": "guardian_name",
        "Parent or Guardian Email": "guardian_email",
        "Parent/Guardian Phone": "guardian_phone",
        "Guardian Notes": "notes",
      },
    );
  });
  it("ignores duplicates on blocked rows so they never hold up the valid ones", () => {
    const archivedReview = {
      candidates: [
        {
          student_id: "s9",
          of_row: null,
          display_name: "Mina Nguyen",
          archived: true,
          confidence: "strong",
          reasons: ["same name", "same birth date"],
        },
      ],
      suggested_action: "decide",
      family_context: [],
    };
    const result = importResult({
      valid_rows: 1,
      error_rows: 1,
      rows: [
        {
          row_number: 2,
          data: { legal_first_name: "Mina" },
          issues: [{ code: "missing_last_name", severity: "error", message: "Missing" }],
          is_valid: false,
          duplicate_review: archivedReview,
        },
        {
          row_number: 3,
          data: { legal_first_name: "Ava", legal_last_name: "Nguyen" },
          issues: [],
          is_valid: true,
          duplicate_review: { ...archivedReview, suggested_action: "skip" },
        },
      ],
    });

    assert.deepEqual(
      getDuplicateReviewRows(result).map((row) => row.rowNumber),
      [3],
    );
    const defaults = buildDefaultDuplicateDecisions(result);
    assert.deepEqual(Object.keys(defaults), ["3"]);
    assert.equal(hasUnresolvedDuplicateDecisions(result, defaults), false);
    assert.equal(countDuplicateSkips(result, defaults), 1);
  });
  it("requires a decision when any possible match is archived and sizes the primary button", () => {
    const archivedReview = {
      candidates: [
        {
          student_id: "live",
          of_row: null,
          display_name: "Ava Nguyen",
          archived: false,
          confidence: "possible",
          reasons: ["same name"],
        },
        {
          student_id: "old",
          of_row: null,
          display_name: "Ava Nguyen",
          archived: true,
          confidence: "possible",
          reasons: ["same name"],
        },
      ],
      suggested_action: "decide",
      family_context: [],
      acknowledge_student_ids: ["old"],
      acknowledge_rows: [],
    };
    const strongReview = {
      candidates: [
        {
          student_id: "s1",
          of_row: null,
          display_name: "Leo Nguyen",
          archived: false,
          confidence: "strong",
          reasons: ["same name", "same birth date"],
        },
      ],
      suggested_action: "skip",
      family_context: [],
      acknowledge_student_ids: ["s1"],
      acknowledge_rows: [],
    };
    const result = importResult({
      valid_rows: 2,
      rows: [
        {
          row_number: 2,
          data: { legal_first_name: "Ava", legal_last_name: "Nguyen" },
          issues: [],
          is_valid: true,
          duplicate_review: archivedReview,
        },
        {
          row_number: 3,
          data: { legal_first_name: "Leo", legal_last_name: "Nguyen" },
          issues: [],
          is_valid: true,
          duplicate_review: strongReview,
        },
      ],
    });

    const defaults = buildDefaultDuplicateDecisions(result);
    assert.deepEqual(Object.keys(defaults), ["3"]);
    assert.equal(hasUnresolvedDuplicateDecisions(result, defaults), true);
    assert.deepEqual(getImportActionState(result, defaults), {
      importCount: 1,
      skipCount: 1,
      label: "Import 1 student",
      disabled: true,
      reason: "unresolved",
    });

    const chosen = { ...defaults, 2: buildDuplicateDecision(archivedReview, "skip") };
    assert.deepEqual(chosen[2], {
      action: "skip",
      matched_student_id: "live",
      of_row: null,
      acknowledged_student_ids: ["old"],
      acknowledged_rows: [],
    });
    assert.equal(hasUnresolvedDuplicateDecisions(result, chosen), false);
    assert.deepEqual(getImportActionState(result, chosen), {
      importCount: 0,
      skipCount: 2,
      label: "Finish, skip 2 already in Koaryu",
      disabled: false,
      reason: null,
    });

    const created = { ...chosen, 2: buildDuplicateDecision(archivedReview, "create") };
    assert.deepEqual(getImportActionState(result, created), {
      importCount: 1,
      skipCount: 1,
      label: "Import 1 student",
      disabled: false,
      reason: null,
    });
    assert.deepEqual(getImportActionState(importResult(), {}), {
      importCount: 0,
      skipCount: 0,
      label: "Import 0 students",
      disabled: true,
      reason: "nothing",
    });
  });
});

it("shows guardian-only family context without a duplicate decision or skip", () => {
  const result = {
    valid_rows: 2,
    total_rows: 2,
    error_rows: 0,
    duplicate_flagged_rows: 0,
    rows: [
      {
        row_number: 2,
        is_valid: true,
        data: { legal_first_name: "Mina", legal_last_name: "Nguyen" },
        issues: [],
        duplicate_review: {
          candidates: [],
          family_context: ["Shares a guardian with Ava Nguyen; likely family"],
          suggested_action: "create",
          guardian_outcome: { kind: "link_existing", display_name: "Jordan Smith", of_row: null },
        },
      },
      {
        row_number: 3,
        is_valid: true,
        data: { legal_first_name: "Sam", legal_last_name: "Nguyen" },
        issues: [],
        duplicate_review: {
          candidates: [],
          family_context: [],
          suggested_action: "create",
          guardian_outcome: { kind: "in_file_shared", display_name: "Jordan Smith", of_row: 2 },
        },
      },
    ],
  };
  const rows = getDuplicateReviewRows(result);
  assert.deepEqual(
    rows.map((r) => [r.rowNumber, r.needsChoice, r.decisionRequired]),
    [
      [2, false, false],
      [3, false, false],
    ],
  );
  assert.deepEqual(buildDefaultDuplicateDecisions(result), {});
  assert.equal(hasUnresolvedDuplicateDecisions(result, {}), false);
  assert.equal(countDuplicateSkips(result, {}), 0);
});

it("the guardian line follows the owner's choice for the row it shares a contact with", () => {
  const shared = {
    candidates: [],
    family_context: [],
    suggested_action: "create",
    guardian_outcome: { kind: "in_file_shared", display_name: "Jordan Smith", of_row: 2 },
  };
  const linked = {
    ...shared,
    guardian_outcome: { kind: "link_existing", display_name: "Jordan Smith", of_row: null },
  };
  assert.equal(describeGuardianOutcome(shared), "Will share the contact from row 2");
  assert.equal(
    describeGuardianOutcome(shared, { 2: { action: "create" } }),
    "Will share the contact from row 2",
  );
  assert.equal(
    describeGuardianOutcome(shared, { 2: { action: "skip" } }),
    "A separate contact will be created because row 2 is skipped",
  );
  assert.equal(
    describeGuardianOutcome(linked, { 2: { action: "skip" } }),
    "Will be linked to the existing contact Jordan Smith",
  );
  assert.equal(describeGuardianOutcome({ ...shared, guardian_outcome: null }), null);
});
