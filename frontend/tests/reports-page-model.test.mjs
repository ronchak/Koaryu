import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAttendanceBySession,
  buildReportLeadMetrics,
  buildReportProgramLeadRows,
  buildReportSessionRows,
  buildReportsPageModel,
  countUniqueReportAttendees,
  formatReportPercent,
  subtractReportDays,
} from "../src/lib/report-metrics.ts";

function lead(overrides = {}) {
  return {
    id: "lead-1",
    studio_id: "studio-1",
    first_name: "Ava",
    last_name: "Nguyen",
    stage: "inquiry",
    source: "website",
    follow_up_date: null,
    program_id: null,
    program_interest: null,
    is_minor: false,
    created_at: "2026-05-20T12:00:00.000Z",
    updated_at: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

function program(overrides = {}) {
  return {
    id: "program-1",
    studio_id: "studio-1",
    name: "Kids BJJ",
    color_hex: "#38BDF8",
    sort_order: 10,
    is_system: false,
    archived_at: null,
    created_at: "2026-05-20T12:00:00.000Z",
    updated_at: "2026-05-20T12:00:00.000Z",
    usage: {
      active_class_count: 0,
      active_student_count: 0,
      belt_ladder_count: 0,
      class_count: 0,
      lead_count: 0,
      student_count: 0,
    },
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    id: "session-1",
    template_id: null,
    program_id: "program-1",
    name: "Kids BJJ",
    date: "2026-05-24",
    start_time: "16:00",
    end_time: "17:00",
    capacity: 20,
    attendance_count: 3,
    status: "scheduled",
    created_at: "2026-05-20T12:00:00.000Z",
    updated_at: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

function attendance(overrides = {}) {
  return {
    id: "attendance-1",
    session_id: "session-1",
    student_id: "student-1",
    student_name: "Student One",
    status: "present",
    checked_in_at: "2026-05-24T16:00:00.000Z",
    created_at: "2026-05-24T16:00:00.000Z",
    updated_at: "2026-05-24T16:00:00.000Z",
    ...overrides,
  };
}

describe("reports page model", () => {
  it("formats report ranges and percentages deterministically", () => {
    assert.equal(subtractReportDays("2026-05-24", 29), "2026-04-25");
    assert.equal(formatReportPercent(0.625), "63%");
    assert.equal(formatReportPercent(null), "—");
  });

  it("builds lead funnel and source metrics outside the route", () => {
    const metrics = buildReportLeadMetrics([
      lead({ id: "lead-1", stage: "inquiry", source: "website" }),
      lead({ id: "lead-2", stage: "enrolled", source: "website" }),
      lead({ id: "lead-3", stage: "closed_lost", source: "referral" }),
    ]);

    assert.equal(metrics.totalLeads, 3);
    assert.equal(metrics.activePipelineLeads, 2);
    assert.equal(metrics.enrolledLeads, 1);
    assert.equal(metrics.leadStageCounts.closed_lost, 1);
    assert.deepEqual(
      metrics.funnelRows.map((row) => [row.stage, row.count, row.share]),
      [
        ["inquiry", 1, 0.5],
        ["trial_scheduled", 0, 0],
        ["trial_completed", 0, 0],
        ["offer_sent", 0, 0],
        ["enrolled", 1, 0.5],
      ]
    );
    assert.equal(metrics.sourceRows[0].source, "website");
    assert.equal(metrics.sourceRows[0].conversionRate, 0.5);
  });

  it("builds attendance session rows from non-absent records and keeps raw date-window unique attendee semantics", () => {
    const attendanceRows = [
      attendance({ id: "a-1", session_id: "session-1", student_id: "student-1", status: "present" }),
      attendance({ id: "a-2", session_id: "session-1", student_id: "student-2", status: "absent" }),
      attendance({ id: "a-3", session_id: "canceled", student_id: "student-3", status: "present" }),
    ];
    const attendanceBySession = buildAttendanceBySession(attendanceRows);
    const sessions = [
      session({ id: "session-1", date: "2026-05-24", start_time: "16:00", capacity: 4 }),
      session({ id: "old", date: "2026-04-01" }),
      session({ id: "canceled", date: "2026-05-23", status: "canceled" }),
    ];
    const sessionRows = buildReportSessionRows({
      attendanceBySession,
      lookbackStart: "2026-04-25",
      sessions,
      today: "2026-05-24",
    });

    assert.deepEqual(sessionRows.map((row) => row.id), ["session-1"]);
    assert.equal(sessionRows[0].attendees, 1);
    assert.equal(sessionRows[0].utilization, 0.25);
    assert.equal(countUniqueReportAttendees({
      attendance: attendanceRows,
      lookbackStart: "2026-04-25",
      sessions,
      today: "2026-05-24",
    }), 2);
  });

  it("derives complete reports page state for the route", () => {
    const model = buildReportsPageModel({
      attendance: [
        attendance({ id: "a-1", session_id: "session-1", student_id: "student-1" }),
        attendance({ id: "a-2", session_id: "session-1", student_id: "student-2" }),
      ],
      leads: [
        lead({ id: "lead-1", program_id: "program-1", stage: "enrolled", source: "website" }),
        lead({ id: "lead-2", program_id: null, program_interest: "Trial", stage: "closed_lost", source: "referral" }),
      ],
      programs: [
        program({ id: "program-1", name: "Kids BJJ" }),
        program({ id: "archived", name: "Archived", archived_at: "2026-05-01T00:00:00.000Z" }),
      ],
      sessions: [
        session({ id: "session-1", program_id: "program-1", date: "2026-05-24", capacity: 4 }),
      ],
      today: "2026-05-24",
    });

    assert.equal(model.lookbackStart, "2026-04-25");
    assert.equal(model.programById.get("program-1").name, "Kids BJJ");
    assert.equal(model.attendanceMetrics.totalAttendance, 2);
    assert.equal(model.attendanceMetrics.utilizationRate, 0.5);
    assert.deepEqual(model.visibleSessionRows.map((row) => row.id), ["session-1"]);
    assert.deepEqual(model.programLeadRows.map((row) => [row.label, row.total]), [["Kids BJJ", 1], ["Trial", 1]]);
    assert.deepEqual(model.programAttendanceRows.map((row) => [row.label, row.attendance]), [["Kids BJJ", 2]]);
    assert.equal(model.uniqueAttendees, 2);
  });

  it("sorts program lead rows by volume and label", () => {
    const rows = buildReportProgramLeadRows({
      leads: [
        lead({ id: "lead-1", program_id: "adult", stage: "inquiry" }),
        lead({ id: "lead-2", program_id: "kids", stage: "enrolled" }),
        lead({ id: "lead-3", program_id: "kids", stage: "closed_lost" }),
      ],
      programs: [
        program({ id: "kids", name: "Kids" }),
        program({ id: "adult", name: "Adults" }),
      ],
    });

    assert.deepEqual(rows.map((row) => [row.label, row.total, row.active, row.enrolled]), [
      ["Kids", 2, 1, 1],
      ["Adults", 1, 1, 0],
    ]);
  });
});
