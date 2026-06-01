import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatScheduleDateKey,
  getActiveScheduleStudents,
  getScheduleSessionAttendance,
  getScheduleWeekDates,
  getVisibleScheduleRange,
  navigateScheduleDate,
  recurringClassOverlapsRange,
} from "../src/lib/schedule-page-model.ts";

function student(id, status) {
  return { id, status };
}

describe("schedule page model", () => {
  it("builds day, week, and month visible ranges from local calendar dates", () => {
    const base = new Date(2026, 4, 20, 15);

    assert.equal(formatScheduleDateKey(base), "2026-05-20");
    assert.deepEqual(
      getScheduleWeekDates(base).map(formatScheduleDateKey),
      [
        "2026-05-17",
        "2026-05-18",
        "2026-05-19",
        "2026-05-20",
        "2026-05-21",
        "2026-05-22",
        "2026-05-23",
      ]
    );
    assert.deepEqual(getVisibleScheduleRange(base, "day"), {
      start: "2026-05-20",
      end: "2026-05-20",
    });
    assert.deepEqual(getVisibleScheduleRange(base, "week"), {
      start: "2026-05-17",
      end: "2026-05-23",
    });
    assert.deepEqual(getVisibleScheduleRange(base, "month"), {
      start: "2026-04-26",
      end: "2026-06-06",
    });
  });

  it("navigates by the active schedule view", () => {
    const base = new Date(2026, 4, 20, 15);

    assert.equal(formatScheduleDateKey(navigateScheduleDate(base, "day", 1)), "2026-05-21");
    assert.equal(formatScheduleDateKey(navigateScheduleDate(base, "week", -1)), "2026-05-13");
    assert.equal(formatScheduleDateKey(navigateScheduleDate(base, "month", 1)), "2026-06-20");
  });

  it("checks recurring-class overlap and selected-session attendance outside the route", () => {
    const visibleRange = { start: "2026-05-17", end: "2026-05-23" };

    assert.equal(
      recurringClassOverlapsRange({ startDate: "2026-05-01", endDate: "2026-05-18" }, visibleRange),
      true
    );
    assert.equal(
      recurringClassOverlapsRange({ startDate: "2026-05-24", endDate: null }, visibleRange),
      false
    );
    assert.deepEqual(
      getScheduleSessionAttendance(
        [
          { id: "att-1", session_id: "session-1" },
          { id: "att-2", session_id: "session-2" },
        ],
        { id: "session-1" }
      ),
      [{ id: "att-1", session_id: "session-1" }]
    );
    assert.deepEqual(getScheduleSessionAttendance([{ id: "att-1", session_id: "session-1" }], null), []);
  });

  it("keeps only active and trialing students available for attendance", () => {
    assert.deepEqual(
      getActiveScheduleStudents([
        student("active", "active"),
        student("trialing", "trialing"),
        student("inactive", "inactive"),
        student("paused", "paused"),
      ]).map((item) => item.id),
      ["active", "trialing"]
    );
  });
});
