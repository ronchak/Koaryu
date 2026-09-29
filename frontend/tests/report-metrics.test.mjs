import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildProgramAttendanceRows,
  calculateAttendanceMetrics,
} from "../src/lib/report-metrics.ts";

describe("calculateAttendanceMetrics", () => {
  it("uses only capped-session attendance for utilization while keeping all visits", () => {
    const metrics = calculateAttendanceMetrics([
      { attendees: 12, capacity: 20 },
      { attendees: 8, capacity: null },
      { attendees: 5, capacity: 0 },
    ]);

    assert.equal(metrics.totalAttendance, 25);
    assert.equal(metrics.totalCapacity, 20);
    assert.equal(metrics.sessionsWithCapacity, 1);
    assert.equal(metrics.utilizationRate, 12 / 20);
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
  it("keeps program ranking by all visits and tracks capped-session visits separately", () => {
    const rows = buildProgramAttendanceRows(
      [
        { program_id: "kids", attendees: 10, capacity: 20 },
        { program_id: "kids", attendees: 100, capacity: null },
        { program_id: "kids", attendees: 5, capacity: 0 },
        { program_id: "adults", attendees: 8, capacity: null },
        { program_id: "sparring", attendees: 12, capacity: 10 },
      ],
      (programId) => programId || "No program",
    );

    assert.equal(rows.length, 3);
    assert.equal(rows[0].label, "kids");
    assert.equal(rows[0].sessions, 3);
    assert.equal(rows[0].attendance, 115);
    assert.equal(rows[0].attendanceWithCapacity, 10);
    assert.equal(rows[0].capacity, 20);
    assert.equal(rows[0].attendanceWithCapacity / rows[0].capacity, 0.5);
    assert.equal(rows[1].label, "sparring");
    assert.equal(rows[1].attendanceWithCapacity / rows[1].capacity, 1.2);
    assert.equal(rows[2].label, "adults");
    assert.equal(rows[2].attendance, 8);
    assert.equal(rows[2].attendanceWithCapacity, 0);
    assert.equal(rows[2].capacity, 0);
  });
});
