import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDashboardBeltStats,
  buildDashboardChurnStats,
  buildDashboardInactivityStats,
  buildDashboardLeadStats,
  buildDashboardNewStudentStats,
  buildDashboardOperationalStats,
  buildDashboardProgramBuckets,
  buildDashboardRecentStudentRows,
  buildDashboardStudentStats,
  buildDashboardTestReadinessStats,
  countDashboardTodaySessions,
} from "../src/lib/dashboard-page-model.ts";

function student(id, overrides = {}) {
  return {
    id,
    legal_first_name: "Ava",
    legal_last_name: "Lane",
    preferred_name: undefined,
    status: "active",
    created_at: "2026-05-01T00:00:00.000Z",
    program_id: null,
    program_memberships: [],
    ...overrides,
  };
}

function lead(id, overrides = {}) {
  return {
    id,
    first_name: "Lead",
    last_name: id,
    stage: "new",
    source: "walk_in",
    is_minor: false,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function program(id, overrides = {}) {
  return {
    id,
    name: id,
    sort_order: 0,
    color_hex: "#22C55E",
    is_system: false,
    usage: {},
    ...overrides,
  };
}

function session(id, overrides = {}) {
  return {
    id,
    date: "2026-05-24",
    status: "scheduled",
    attendance_count: 0,
    ...overrides,
  };
}

function attendance(id, sessionId, status = "present") {
  return {
    id,
    session_id: sessionId,
    status,
    checked_in_at: "2026-05-24T10:00:00.000Z",
  };
}

describe("dashboard page model", () => {
  it("counts roster, lead, belt, inactivity, churn, and readiness stats outside the route", () => {
    const students = [
      student("active", { membership_start_date: "2026-05-20" }),
      student("trial-hold", {
        status: "trialing",
        membership_start_date: "2026-05-01",
        hold_start_date: "2026-05-20",
        hold_end_date: "2026-05-25",
      }),
      student("paused", { status: "paused", membership_start_date: "2026-03-01" }),
      student("inactive", { status: "inactive", membership_start_date: "2026-05-15" }),
      student("canceled", { status: "canceled", membership_start_date: "2026-05-15" }),
      student("future", { membership_start_date: "2026-06-01" }),
    ];

    assert.deepEqual(buildDashboardStudentStats(students, "2026-05-24"), {
      totalStudents: 6,
      activeStudents: 3,
      trialingStudents: 1,
      onHoldStudents: 2,
    });
    assert.deepEqual(
      buildDashboardNewStudentStats(students, "2026-05-24", "2026-05-10", "2026-04-24", "2026-02-23", "2026-01-01"),
      {
        new14: 1,
        new30: 2,
        new90: 3,
        newYearToDate: 3,
      }
    );
    assert.deepEqual(buildDashboardChurnStats(students), {
      inactiveStudents: 1,
      canceledStudents: 1,
      churnMarkedStudents: 2,
      churnRate: 2 / 6,
    });
    assert.deepEqual(
      buildDashboardLeadStats([
        lead("due", { follow_up_date: "2026-05-24" }),
        lead("future", { follow_up_date: "2026-05-25" }),
        lead("enrolled", { stage: "enrolled" }),
        lead("lost", { stage: "closed_lost" }),
      ], "2026-05-24"),
      {
        activeLeads: 2,
        enrolledLeads: 1,
        dueTodayLeads: 1,
      }
    );
    assert.deepEqual(buildDashboardBeltStats([{ is_tip: false }, { is_tip: true }, { is_tip: true }]), {
      beltCount: 1,
      tipCount: 2,
    });
    assert.deepEqual(buildDashboardInactivityStats([{ daysInactive: 10 }, { daysInactive: 14 }, { daysInactive: 30 }, { daysInactive: 90 }]), {
      watch14: 3,
      watch30: 2,
      watch90: 1,
      highestRiskStudents: [{ daysInactive: 14 }, { daysInactive: 30 }, { daysInactive: 90 }],
    });
    assert.deepEqual(
      buildDashboardTestReadinessStats([
        { is_eligible: true },
        { is_eligible: false, classes_met: true, time_met: true, needs_approval: true },
        { is_eligible: false, classes_met: true, time_met: false, needs_approval: true },
      ]),
      {
        readyToTest: 1,
        needsApproval: 1,
      }
    );
  });

  it("calculates operational attendance without canceled, future, absent, or pre-window sessions", () => {
    const sessions = [
      session("capacity", { capacity: 10, attendance_count: 9 }),
      session("no-capacity", { attendance_count: 5 }),
      session("canceled", { capacity: 10, status: "canceled" }),
      session("old", { date: "2026-04-20", capacity: 10, attendance_count: 10 }),
      session("future", { date: "2026-05-25", capacity: 10, attendance_count: 10 }),
    ];
    const records = [
      attendance("present", "capacity"),
      attendance("late", "capacity", "late"),
      attendance("absent", "capacity", "absent"),
    ];

    assert.equal(countDashboardTodaySessions(sessions, "2026-05-24"), 3);
    assert.deepEqual(
      buildDashboardOperationalStats(records, sessions, "2026-04-24", "2026-05-24"),
      {
        attendanceWithCapacity: 2,
        totalCapacity: 10,
        sessionsTracked: 2,
        sessionsWithCapacity: 1,
        utilizationRate: 0.2,
        averageAttendance: 3.5,
      }
    );
  });

  it("builds recent student rows from summary, local full roster, or partial-roster guardrails", () => {
    assert.deepEqual(
      buildDashboardRecentStudentRows(
        [{ id: "summary-student", display_name: "Summary Student", status: "active", started_on: null }],
        [student("local")],
        false
      ),
      [{ id: "summary-student", displayName: "Summary Student", status: "active", startedOn: null }]
    );
    assert.deepEqual(buildDashboardRecentStudentRows(null, [student("partial")], true), []);
    assert.deepEqual(
      buildDashboardRecentStudentRows(null, [student("local", { preferred_name: "Ace", legal_last_name: "Stone" })], false),
      [{ id: "local", displayName: "Ace Stone", status: "active", startedOn: "2026-05-01" }]
    );
  });

  it("aggregates program buckets from active students, open leads, and today's non-canceled sessions", () => {
    const programs = [
      program("kids", { name: "Kids" }),
      program("archived", { name: "Archived", archived_at: "2026-05-01" }),
    ];
    const programById = new Map(programs.map((item) => [item.id, item]));
    const rows = buildDashboardProgramBuckets(
      programs,
      programById,
      [
        student("active-kids", {
          program_memberships: [{ program_id: "kids", status: "active" }],
        }),
        student("trial-archived", { status: "trialing", program_id: "archived" }),
        student("active-unassigned"),
        student("inactive-kids", { status: "inactive", program_id: "kids" }),
      ],
      [
        lead("lead-kids", { program_id: "kids" }),
        lead("lead-unknown", { program_interest: "Birthday Trial" }),
        lead("lead-enrolled", { program_id: "kids", stage: "enrolled" }),
        lead("lead-lost", { program_id: "kids", stage: "closed_lost" }),
      ],
      [
        session("kids-today", { program_id: "kids" }),
        session("archived-canceled", { program_id: "archived", status: "canceled" }),
        session("unassigned-today", { program_id: null }),
      ],
      "2026-05-24"
    );

    const kids = rows.find((row) => row.label === "Kids");
    const unassigned = rows.find((row) => row.label === "No program");
    const archived = rows.find((row) => row.label === "Archived");

    assert.deepEqual(kids, {
      programId: "kids",
      label: "Kids",
      activeStudents: 1,
      trialingStudents: 0,
      activeLeads: 1,
      todaySessions: 1,
    });
    assert.deepEqual(unassigned, {
      programId: null,
      label: "No program",
      activeStudents: 1,
      trialingStudents: 0,
      activeLeads: 1,
      todaySessions: 1,
    });
    assert.equal(archived.trialingStudents, 1);
    assert.equal(rows[0].label, "Kids");
  });
});
