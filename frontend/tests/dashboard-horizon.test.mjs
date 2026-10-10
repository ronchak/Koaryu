import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildHorizonBrief,
  dashboardGreeting,
  dayPeriodForHour,
  describeFollowUpDue,
  formatDashboardDate,
  greetingName,
  HORIZON_RIDGE_PATHS,
  horizonWeek,
} from "../src/lib/dashboard-horizon.ts";

describe("Horizon dashboard helpers", () => {
  it("greets by part of day and preferred first name, never an email", () => {
    assert.equal(dayPeriodForHour(4), "evening");
    assert.equal(dayPeriodForHour(5), "morning");
    assert.equal(dayPeriodForHour(12), "afternoon");
    assert.equal(dayPeriodForHour(17), "evening");
    assert.equal(greetingName("Ronak Chakraborty", "Ronak"), "Ronak");
    assert.equal(greetingName("owner@studio.test", "Mina"), "Mina");
    assert.equal(greetingName(undefined, undefined), "");
    assert.equal(dashboardGreeting("afternoon", "Ronak"), "Good afternoon, Ronak.");
    assert.equal(dashboardGreeting("morning", ""), "Good morning.");
    // Server render and hydration have no clock, so they share a neutral greeting.
    assert.equal(dashboardGreeting(null, "Ronak"), "Welcome back, Ronak.");
  });

  it("formats the studio business date and its Sunday-to-Saturday week", () => {
    assert.equal(formatDashboardDate("2026-10-10"), "Saturday, October 10");
    assert.equal(formatDashboardDate(""), "");
    const week = horizonWeek("2026-10-10");
    assert.equal(week.length, 7);
    assert.equal(week[0].iso, "2026-10-04");
    assert.equal(week[0].weekday, "Sun");
    assert.deepEqual(
      week.filter((day) => day.isToday).map((day) => day.iso),
      ["2026-10-10"],
    );
    assert.deepEqual(horizonWeek("not a date"), []);
  });

  it("describes how late a follow-up is in the largest natural unit", () => {
    assert.equal(describeFollowUpDue("2026-10-10", "2026-10-10"), "Due today");
    assert.equal(describeFollowUpDue("2026-10-09", "2026-10-10"), "1 day overdue");
    assert.equal(describeFollowUpDue("2026-09-30", "2026-10-10"), "10 days overdue");
    assert.equal(describeFollowUpDue("2026-08-15", "2026-10-10"), "8 weeks overdue");
    assert.equal(describeFollowUpDue("2026-06-01", "2026-10-10"), "4 months overdue");
    assert.equal(describeFollowUpDue("2026-10-11", "2026-10-10"), null);
  });

  it("writes the brief only from settled panels", () => {
    assert.deepEqual(
      buildHorizonBrief({
        attention: { state: "ready", count: 2 },
        classes: { state: "empty", count: 0 },
        promotions: { state: "ready", count: 3 },
      }),
      {
        lead: "Two things need you today.",
        rest: ["No classes on the schedule today.", "Three students are ready for the next belt."],
      },
    );
    assert.deepEqual(
      buildHorizonBrief({
        attention: { state: "empty", count: 0 },
        classes: { state: "ready", count: 1 },
        promotions: { state: "ready", count: 0 },
      }),
      { lead: "Nothing needs you right now.", rest: ["One class on the schedule today."] },
    );
    // Loading panels and a partial empty check never claim the day is clear.
    assert.deepEqual(
      buildHorizonBrief({
        attention: { state: "partial", count: 0 },
        classes: { state: "loading", count: 0 },
        promotions: null,
      }),
      { lead: null, rest: [] },
    );
  });

  it("draws five closed ridges, far to near", () => {
    assert.equal(HORIZON_RIDGE_PATHS.length, 5);
    for (const path of HORIZON_RIDGE_PATHS) {
      assert.match(path, /^M-120\.0 /);
      assert.match(path, /Z$/);
    }
  });
});
