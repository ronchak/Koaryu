import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  studentBirthDateError,
  parseStudentImportBirthDate,
} from "../src/lib/student-birth-date.ts";
import { studioDateKey } from "../src/lib/date.ts";
import {
  buildInitialStudentFormFields,
  validateStudentFormFields,
} from "../src/components/students/student-form-state.ts";
import { buildPreviewStudent, applyPreviewStudentUpdate } from "../src/lib/student-store-model.ts";
import { buildPreviewStudentImportResult } from "../src/lib/student-import-store-model.ts";

describe("student birth dates", () => {
  it("accepts today, past leap dates, and missing dates", () => {
    for (const dob of [null, undefined, "", "2026-09-29", "2008-02-29"]) {
      assert.equal(studentBirthDateError(dob, "2026-09-29"), undefined);
    }
    for (const dob of ["2026-09-30", "2027-01-01"]) {
      assert.equal(
        studentBirthDateError(dob, "2026-09-29"),
        "Date of birth cannot be in the future.",
      );
    }
    for (const dob of [
      "2026-02-30",
      "2025-02-29",
      "2026-13-01",
      "2026-00-00",
      "0000-01-01",
      "invalid",
    ]) {
      assert.equal(studentBirthDateError(dob, "2026-09-29"), "Enter a valid date of birth.");
    }
  });
  it("validates the form against the studio date when UTC and browser dates differ", () => {
    const now = new Date("2026-09-30T01:00:00Z");
    const fields = {
      ...buildInitialStudentFormFields(),
      legalFirst: "Aiko",
      legalLast: "Tanaka",
      dob: "2026-09-30",
    };
    assert.deepEqual(
      validateStudentFormFields(fields, {
        businessDate: studioDateKey("America/Los_Angeles", now),
      }),
      {
        message: "Date of birth cannot be in the future.",
        tab: "info",
      },
    );
    assert.equal(
      validateStudentFormFields(fields, { businessDate: studioDateKey("Pacific/Kiritimati", now) }),
      null,
    );
  });
  it("rejects direct preview create/update before changing student data", () => {
    const options = { businessDate: "2026-09-29", idFactory: () => "student-1" };
    const data = {
      legal_first_name: "Aiko",
      legal_last_name: "Tanaka",
      date_of_birth: "2026-09-30",
    };
    assert.throws(() => buildPreviewStudent(data, [], options), /cannot be in the future/);
    const saved = buildPreviewStudent({ ...data, date_of_birth: "2026-09-29" }, [], options);
    assert.throws(
      () => applyPreviewStudentUpdate(saved, { date_of_birth: "2027-01-01" }, [], options),
      /cannot be in the future/,
    );
    assert.equal(saved.date_of_birth, "2026-09-29");
    assert.equal(
      applyPreviewStudentUpdate(saved, { notes: "Unrelated edit" }, [], options).date_of_birth,
      "2026-09-29",
    );
    assert.equal(
      applyPreviewStudentUpdate(saved, { date_of_birth: null }, [], options).date_of_birth,
      null,
    );
  });
  it("retains the supported CSV birth date formats", () => {
    for (const dob of [
      "2008-02-29",
      "2008/02/29",
      "02/29/2008",
      "02/29/08",
      "02-29-2008",
      "02.29.08",
      "February 29, 2008",
      "Feb 29 2008",
      "2008-02-29T00:00:00Z",
      "39507",
    ]) {
      assert.equal(parseStudentImportBirthDate(dob), "2008-02-29", dob);
    }
    assert.equal(parseStudentImportBirthDate("02/30/2026"), null);
  });
  it("reports future and invalid CSV dates per row without importing them", () => {
    const result = buildPreviewStudentImportResult({
      rows: ["09/30/2026", "2026-09-29", "02/29/2008", "2026-02-30"].map((DOB) => ({
        Name: "Aiko Tanaka",
        DOB,
      })),
      mapping: { Name: "full_name", DOB: "date_of_birth" },
      options: {},
      programs: [],
      beltLadders: [],
      fallbackRanks: [],
      existingStudents: [],
      idFactory: () => "new-student",
      businessDate: "2026-09-29",
    });
    assert.equal(result.result.valid_rows, 2);
    assert.equal(result.result.error_rows, 2);
    assert.equal(result.students.length, 2);
    assert.deepEqual(
      result.result.errors.map((row) => row.issues[0].code),
      ["future_date_of_birth", "invalid_date_of_birth"],
    );
  });
});
