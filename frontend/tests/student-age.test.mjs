import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarAge, isMinorOnDate, withCurrentMinorStatus } from "../src/lib/student-age.ts";
import { buildPreviewLeadConversion } from "../src/lib/lead-store-model.ts";
import { applyPreviewStudentUpdate } from "../src/lib/student-store-model.ts";

test("explicit minor knowledge survives no-DOB conversion, editing and reload", () => {
  let sequence = 0;
  const { student } = buildPreviewLeadConversion(
    {
      id: "lead-1",
      first_name: "Kai",
      last_name: "Stone",
      is_minor: true,
      guardian_name: "Mina Stone",
      program_id: "kids",
    },
    [],
    { idFactory: () => `id-${++sequence}`, now: new Date("2026-09-30T12:00:00Z") },
  );
  assert.equal(student.date_of_birth, undefined);
  assert.equal(student.is_minor, true);
  const edited = applyPreviewStudentUpdate(student, { notes: "Edited", date_of_birth: null }, [], {
    idFactory: () => {
      throw new Error("Unrelated edit must not create relationships");
    },
    businessDate: "2026-09-30",
  });
  const reloaded = withCurrentMinorStatus(JSON.parse(JSON.stringify(edited)), "2026-10-01");
  assert.equal(reloaded.is_minor, true);
  assert.equal(reloaded.date_of_birth, null);
  assert.equal(reloaded.guardians[0].first_name, "Mina");
});

test("DOB overrides stored minor flag and reaches adulthood on the birthday", () => {
  const student = { is_minor: true, date_of_birth: "2008-09-30", guardians: [] };
  assert.equal(withCurrentMinorStatus(student, "2026-09-29").is_minor, true);
  assert.equal(withCurrentMinorStatus(student, "2026-09-30").is_minor, false);
  const cleared = applyPreviewStudentUpdate(student, { date_of_birth: null }, [], {
    idFactory: () => "unused",
    businessDate: "2026-09-30",
  });
  assert.equal(cleared.is_minor, false);
  assert.equal(
    withCurrentMinorStatus({ is_minor: false, guardians: [{}] }, "2026-09-30").is_minor,
    false,
  );
});

test("calendar ages reject impossible or future dates and handle leap birthdays", () => {
  for (const dob of ["2027-01-01", "2026-02-30", "2026-13-01", "2026-00-01", "bad", "0000-01-01"]) {
    assert.equal(calendarAge(dob, "2026-09-30"), null, dob);
    assert.equal(isMinorOnDate(dob, "2026-09-30"), false, dob);
  }
  assert.equal(calendarAge("2008-02-29", "2026-02-28"), 17);
  assert.equal(calendarAge("2008-02-29", "2026-03-01"), 18);
  assert.equal(calendarAge("2026-09-30", "2026-09-30"), 0);
  assert.equal(calendarAge(null, "2026-09-30"), null);
  assert.equal(calendarAge("2010-01-01", "2026-02-30"), null);
});
