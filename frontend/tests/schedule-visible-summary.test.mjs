import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getVisibleScheduleSummary, navigateScheduleDate } from "../src/lib/schedule-page-model.ts";

const session = (id, date, extra = {}) => ({
  id,
  date,
  name: "Karate",
  start_time: "09:00",
  end_time: "10:00",
  program_id: "karate",
  status: "scheduled",
  ...extra,
});
const template = (extra = {}) => ({
  id: "weekly",
  name: "Karate",
  start_time: "09:00",
  end_time: "10:00",
  day_of_week: 2,
  start_date: "2026-09-29",
  end_date: "2026-10-20",
  is_active: true,
  program_id: "karate",
  ...extra,
});
const summary = (currentDate, view, sessions, templates = []) =>
  getVisibleScheduleSummary({ currentDate, view, sessions, templates });

describe("visible schedule summary", () => {
  it("counts the inclusive 42-cell month grid, including adjacent months, without pruning the cache", () => {
    const sessions = [
      session("before", "2026-09-26"),
      session("first", "2026-09-27"),
      session("inside", "2026-10-06"),
      session("last", "2026-11-07"),
      session("after", "2026-11-08"),
    ];
    const before = structuredClone(sessions);
    assert.deepEqual(summary(new Date(2026, 9, 15, 12), "month", sessions), {
      scheduled: 3,
      recurringSlots: 0,
    });
    assert.deepEqual(sessions, before);
  });

  it("updates month, week and day summaries after navigation and returns zero for an empty range", () => {
    const base = new Date(2026, 8, 29, 12);
    const sessions = [session("sept", "2026-09-29"), session("oct", "2026-10-06")];
    for (const [view, expectedInitial, expectedNext] of [
      ["month", 2, 2],
      ["week", 1, 1],
      ["day", 1, 0],
    ]) {
      assert.equal(summary(base, view, sessions).scheduled, expectedInitial);
      assert.equal(
        summary(navigateScheduleDate(base, view, 1), view, sessions).scheduled,
        expectedNext,
      );
      assert.deepEqual(summary(new Date(2026, 10, 29, 12), view, sessions), {
        scheduled: 0,
        recurringSlots: 0,
      });
    }
  });

  it("counts recurring placeholders by occurrence with inclusive dates and active weekday rules", () => {
    const templates = [
      template(),
      template({ id: "inactive", is_active: false }),
      template({ id: "future", start_date: "2027-01-01", end_date: null }),
      template({ id: "expired", start_date: "2025-01-01", end_date: "2026-09-01" }),
    ];
    assert.deepEqual(summary(new Date(2026, 9, 15, 12), "month", [], templates), {
      scheduled: 0,
      recurringSlots: 4,
    });
    assert.equal(summary(new Date(2026, 8, 29, 12), "day", [], templates).recurringSlots, 1);
    assert.equal(summary(new Date(2026, 9, 20, 12), "day", [], templates).recurringSlots, 1);
    assert.equal(summary(new Date(2026, 9, 21, 12), "day", [], templates).recurringSlots, 0);
    assert.equal(summary(new Date(2026, 9, 27, 12), "day", [], templates).recurringSlots, 0);
  });

  it("matches generated and cancelled sessions and recreates a placeholder after session deletion", () => {
    const date = new Date(2026, 9, 6, 12);
    const generated = session("generated", "2026-10-06", {
      template_id: "weekly",
      name: "Renamed generated class",
      status: "cancelled",
    });
    assert.deepEqual(summary(date, "day", [generated], [template()]), {
      scheduled: 1,
      recurringSlots: 0,
    });
    assert.deepEqual(summary(date, "day", [], [template()]), {
      scheduled: 0,
      recurringSlots: 1,
    });
    assert.deepEqual(summary(date, "day", [], []), { scheduled: 0, recurringSlots: 0 });
    // Legacy generated sessions match by name and times just as in the calendar.
    assert.equal(
      summary(date, "day", [session("legacy", "2026-10-06")], [template()]).recurringSlots,
      0,
    );
  });
});
