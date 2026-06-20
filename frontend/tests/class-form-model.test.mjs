import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildClassFormInitialState,
  buildClassFormModeState,
  buildClassFormSubmitDecision,
  formatDateLabel,
  formatTimeLabel,
  getDayOfWeekFromDate,
  parseTimeToMinutes,
  todayDateString,
} from "../src/lib/class-form-model.ts";

describe("class form model", () => {
  it("builds initial state from aliases and calendar defaults", () => {
    assert.equal(todayDateString(new Date(2026, 4, 30)), "2026-05-30");
    assert.equal(getDayOfWeekFromDate("2026-05-30"), 6);

    assert.deepEqual(
      buildClassFormInitialState({
        name: "No Gi",
        program_id: "program-1",
        capacity: 24,
        startDate: "2026-05-30",
      }),
      {
        mode: "weekly",
        name: "No Gi",
        date: "2026-05-30",
        startTime: "18:00",
        endTime: "19:30",
        programId: "program-1",
        capacity: "24",
        dayOfWeek: 6,
        startDate: "2026-05-30",
        endDate: "",
      }
    );
  });

  it("formats time, date, and mode transitions for the modal summary", () => {
    assert.equal(parseTimeToMinutes("18:30"), 1110);
    assert.equal(formatTimeLabel("18:30"), "6:30 PM");
    assert.equal(formatDateLabel("2026-05-30"), "Sat, May 30");

    const weekly = buildClassFormInitialState({ date: "2026-05-30" }, "single");
    assert.deepEqual(buildClassFormModeState(weekly, "weekly"), {
      mode: "weekly",
      dayOfWeek: 6,
      startDate: "2026-05-30",
    });
    assert.deepEqual(
      buildClassFormModeState({ ...weekly, mode: "weekly", startDate: "2026-06-01" }, "single"),
      {
        mode: "single",
        date: "2026-05-30",
      }
    );
  });

  it("validates and builds weekly and single-session payloads", () => {
    assert.deepEqual(
      buildClassFormSubmitDecision({
        ...buildClassFormInitialState({ mode: "weekly" }),
        name: "",
        startTime: "19:00",
        endTime: "18:00",
        capacity: "0",
        startDate: "",
      }).errors,
      {
        name: "Class name is required.",
        endTime: "End time must be after the start time.",
        capacity: "Capacity must be a positive whole number.",
        startDate: "Choose when the series can begin.",
      }
    );

    assert.deepEqual(
      buildClassFormSubmitDecision({
        ...buildClassFormInitialState({ mode: "weekly", startDate: "2026-05-30" }),
        name: "  Kids Fundamentals  ",
        programId: "program-1",
        capacity: "18",
        dayOfWeek: 6,
        endDate: "",
      }).payload,
      {
        kind: "weekly_template",
        name: "Kids Fundamentals",
        startTime: "18:00",
        endTime: "19:30",
        program_id: "program-1",
        capacity: 18,
        recurrence: {
          frequency: "weekly",
          dayOfWeek: 6,
          startDate: "2026-05-30",
          endDate: undefined,
        },
      }
    );

    assert.deepEqual(
      buildClassFormSubmitDecision({
        ...buildClassFormInitialState({ mode: "single", date: "2026-05-31" }, "single"),
        name: "Open Mat",
        capacity: "",
      }).payload,
      {
        kind: "single_session",
        name: "Open Mat",
        sessionDate: "2026-05-31",
        startTime: "18:00",
        endTime: "19:30",
        program_id: undefined,
        capacity: undefined,
      }
    );
  });
});
