import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareSessions,
  getPreviewTemplateSessionDates,
  mergeAttendanceForSessions,
  mergeSessionsForRange,
  normalizeAttendanceRecords,
  toAttendanceCountDelta,
  updateSessionAttendanceCount,
} from "../src/lib/schedule-store-model.ts";

function session(id, date, startTime, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    name: id,
    date,
    start_time: startTime,
    end_time: "18:00",
    status: "scheduled",
    created_at: "2026-05-24T00:00:00.000Z",
    attendance_count: 0,
    ...overrides,
  };
}

function attendance(id, sessionId, studentId, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    session_id: sessionId,
    student_id: studentId,
    status: "present",
    checked_in_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function template(overrides = {}) {
  return {
    id: "template-1",
    studio_id: "studio-1",
    name: "Kids BJJ",
    day_of_week: 1,
    start_time: "17:00",
    end_time: "18:00",
    start_date: "2026-05-04",
    is_active: true,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("schedule store model", () => {
  it("merges refreshed sessions by replacing only the requested date range", () => {
    const current = [
      session("before", "2026-05-01", "18:00"),
      session("old-in-range", "2026-05-10", "18:00"),
      session("after", "2026-05-30", "18:00"),
    ];
    const fetched = [
      session("new-late", "2026-05-10", "19:00"),
      session("new-early", "2026-05-10", "16:00"),
    ];

    const merged = mergeSessionsForRange(current, fetched, "2026-05-05", "2026-05-20");

    assert.deepEqual(merged.map((item) => item.id), ["before", "new-early", "new-late", "after"]);
    assert.equal(compareSessions(session("a", "2026-05-01", "18:00"), session("b", "2026-05-01", "19:00")) < 0, true);
  });

  it("replaces attendance for fetched sessions and normalizes missing student names", () => {
    const current = [
      attendance("old-1", "session-1", "student-1"),
      attendance("old-2", "session-2", "student-2"),
    ];
    const fetched = normalizeAttendanceRecords([
      attendance("new-1", "session-1", "student-3", { student_name: undefined }),
    ]);

    const merged = mergeAttendanceForSessions(current, fetched, ["session-1"]);

    assert.deepEqual(merged.map((item) => [item.id, item.session_id, item.student_name]), [
      ["old-2", "session-2", undefined],
      ["new-1", "session-1", ""],
    ]);
  });

  it("updates session attendance counts with status deltas and a zero floor", () => {
    assert.equal(toAttendanceCountDelta(null, "present"), 1);
    assert.equal(toAttendanceCountDelta("late", "absent"), -1);
    assert.equal(toAttendanceCountDelta("present", "late"), 0);

    const sessions = [session("session-1", "2026-05-10", "18:00", { attendance_count: 0 })];
    assert.equal(updateSessionAttendanceCount(sessions, "session-1", -1)[0].attendance_count, 0);
    assert.equal(updateSessionAttendanceCount(sessions, "session-1", 2)[0].attendance_count, 2);
    assert.equal(updateSessionAttendanceCount(sessions, "session-1", 0), sessions);
  });

  it("builds preview recurring session dates through the template end date", () => {
    assert.deepEqual(
      getPreviewTemplateSessionDates(template({ start_date: "2026-05-04", end_date: "2026-05-18" })),
      ["2026-05-04", "2026-05-11", "2026-05-18"]
    );
    assert.equal(getPreviewTemplateSessionDates(template({ start_date: "2026-05-04" })).length, 13);
  });
});
