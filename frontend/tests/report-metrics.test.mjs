import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProgramAttendanceRows, calculateAttendanceMetrics } from "../src/lib/report-metrics.ts";

describe("calculateAttendanceMetrics", () => {
  it("preserves the reports route utilization display semantics", () => {
    const metrics = calculateAttendanceMetrics([
      { attendees: 12, capacity: 20 },
      { attendees: 8, capacity: null },
      { attendees: 5, capacity: 0 },
    ]);

    assert.equal(metrics.totalAttendance, 25);
    assert.equal(metrics.totalCapacity, 20);
    assert.equal(metrics.sessionsWithCapacity, 1);
    assert.equal(metrics.utilizationRate, 25 / 20);
    assert.equal(metrics.averageAttendance, 25 / 3);
  });

  it("returns null utilization when no session has positive capacity", () => {
    const metrics = calculateAttendanceMetrics([
      { attendees: 8, capacity: null },
      { attendees: 5, capacity: 0 },
    ]);

    assert.equal(metrics.totalAttendance, 13);
    assert.equal(metrics.totalCapacity, 0);
    assert.equal(metrics.utilizationRate, null);
  });
});

describe("buildProgramAttendanceRows", () => {
  it("preserves program utilization display inputs from the reports route", () => {
    const rows = buildProgramAttendanceRows(
      [
        { program_id: "kids", attendees: 10, capacity: 20 },
        { program_id: "kids", attendees: 100, capacity: null },
      ],
      (programId) => (programId === "kids" ? "Kids" : "No program"),
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, "Kids");
    assert.equal(rows[0].sessions, 2);
    assert.equal(rows[0].attendance, 110);
    assert.equal(rows[0].capacity, 20);
    assert.equal(rows[0].attendance / rows[0].capacity, 5.5);
  });
});
