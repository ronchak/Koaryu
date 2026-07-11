import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildStudentInactivityRows,
  formatInactivityDaysForRange,
} from "../src/lib/student-insights.ts";

describe("student inactivity insights", () => {
  it("uses attendance older than the bootstrap window for a 90-day filter", () => {
    const students = [{
      id: "student-1",
      status: "active",
      membership_start_date: "2025-01-01",
      created_at: "2025-01-01T00:00:00.000Z",
      hold_start_date: null,
      hold_end_date: null,
    }];
    const sessions = [{ id: "session-1", date: "2026-06-01" }];
    const attendance = [{
      id: "attendance-1",
      session_id: "session-1",
      student_id: "student-1",
      status: "present",
      checked_in_at: "2026-06-01T18:00:00.000Z",
    }];

    const [row] = buildStudentInactivityRows(
      students,
      sessions,
      attendance,
      "2026-07-11"
    );

    assert.equal(row.lastAttendanceDate, "2026-06-01");
    assert.equal(row.daysInactive, 40);
    assert.equal(formatInactivityDaysForRange(row, 90), "40");
  });

  it("renders a truthful lower bound when last attendance predates the loaded range", () => {
    const students = [{
      id: "student-1",
      status: "active",
      membership_start_date: "2025-01-01",
      created_at: "2025-01-01T00:00:00.000Z",
      hold_start_date: null,
      hold_end_date: null,
    }];

    const [rangeCensoredRow] = buildStudentInactivityRows(
      students,
      [],
      [],
      "2026-07-11"
    );

    assert.ok(rangeCensoredRow.daysInactive > 90);
    assert.equal(rangeCensoredRow.lastAttendanceDate, undefined);
    assert.equal(formatInactivityDaysForRange(rangeCensoredRow, 90), "90+");

    const [staleCachedRow] = buildStudentInactivityRows(
      students,
      [{ id: "stale-session", date: "2025-12-23" }],
      [{
        id: "stale-attendance",
        session_id: "stale-session",
        student_id: "student-1",
        status: "present",
        checked_in_at: "2025-12-23T18:00:00.000Z",
      }],
      "2026-07-11"
    );
    assert.equal(staleCachedRow.daysInactive, 200);
    assert.equal(formatInactivityDaysForRange(staleCachedRow, 90), "90+");
  });
});
