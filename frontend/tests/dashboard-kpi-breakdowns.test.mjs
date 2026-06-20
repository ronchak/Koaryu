import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildKpiBreakdowns,
  buildRankFamilyIndex,
} from "../src/lib/dashboard-kpi-breakdowns.ts";

function program(id, name, sortOrder = 0) {
  return {
    id,
    studio_id: "studio-1",
    name,
    color_hex: "#22C55E",
    sort_order: sortOrder,
    is_system: false,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    usage: { active_student_count: 0, active_schedule_template_count: 0 },
  };
}

function rank(id, name, order, overrides = {}) {
  return {
    id,
    ladder_id: "ladder-1",
    studio_id: "studio-1",
    name,
    color_hex: "#111111",
    display_order: order,
    min_classes: 0,
    min_months: 0,
    requires_approval: false,
    is_tip: false,
    created_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function student(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    legal_first_name: "Ava",
    legal_last_name: "Lane",
    status: "active",
    program_id: "kids",
    program_memberships: [],
    tags: [],
    guardians: [],
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function session(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    name: "Kids BJJ",
    date: "2026-05-24",
    start_time: "16:00",
    end_time: "17:00",
    program_id: "kids",
    capacity: 2,
    status: "completed",
    created_at: "2026-05-24T00:00:00.000Z",
    attendance_count: 0,
    ...overrides,
  };
}

function attendanceRecord(sessionId, studentId, overrides = {}) {
  return {
    id: `${sessionId}-${studentId}`,
    studio_id: "studio-1",
    session_id: sessionId,
    student_id: studentId,
    status: "present",
    checked_in_at: "2026-05-24T16:00:00.000Z",
    ...overrides,
  };
}

function eligibility(studentId, overrides = {}) {
  return {
    student_id: studentId,
    student_name: "Ava Lane",
    program_id: "kids",
    current_rank_id: "white-stripe",
    current_rank_name: "White Stripe",
    classes_since_promo: 10,
    classes_required: 10,
    days_at_rank: 90,
    days_required: 90,
    classes_met: true,
    time_met: true,
    needs_approval: false,
    is_eligible: true,
    ...overrides,
  };
}

describe("dashboard KPI breakdowns", () => {
  it("indexes tip ranks under their full belt family", () => {
    const kids = program("kids", "Kids BJJ");
    const index = buildRankFamilyIndex(
      [
        {
          id: "ladder-1",
          studio_id: "studio-1",
          name: "Kids Ladder",
          program_id: "kids",
          sub_rank_term: "stripe",
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z",
          ranks: [
            rank("white", "White", 0),
            rank("white-stripe", "White Stripe", 1, { is_tip: true }),
            rank("blue", "Blue", 2),
          ],
        },
      ],
      new Map([[kids.id, kids]])
    );

    assert.deepEqual(
      {
        sectionLabel: index.get("white-stripe")?.sectionLabel,
        groupLabel: index.get("white-stripe")?.groupLabel,
        exactLabel: index.get("white-stripe")?.exactLabel,
      },
      {
        sectionLabel: "Kids BJJ",
        groupLabel: "White",
        exactLabel: "White Stripe",
      }
    );
  });

  it("builds utilization, readiness, churn, and cancellation breakdown sections", () => {
    const kids = program("kids", "Kids BJJ");
    const ranks = [
      rank("white", "White", 0),
      rank("white-stripe", "White Stripe", 1, { is_tip: true }),
      rank("blue", "Blue", 2),
    ];
    const rankFamilyById = buildRankFamilyIndex(
      [
        {
          id: "ladder-1",
          studio_id: "studio-1",
          name: "Kids Ladder",
          program_id: "kids",
          sub_rank_term: "stripe",
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z",
          ranks,
        },
      ],
      new Map([[kids.id, kids]])
    );
    const rankNameById = new Map(ranks.map((item) => [item.id, item.name]));

    const result = buildKpiBreakdowns({
      attendance: [
        attendanceRecord("session-1", "active-white"),
        attendanceRecord("session-1", "canceled-blue"),
        attendanceRecord("session-1", "inactive-none", { status: "absent" }),
        attendanceRecord("old-session", "active-white"),
        attendanceRecord("canceled-session", "active-white"),
      ],
      eligibility: [
        eligibility("active-white"),
        eligibility("inactive-none", { is_eligible: false }),
      ],
      lookback30: "2026-04-24",
      programById: new Map([[kids.id, kids]]),
      rankFamilyById,
      rankNameById,
      sessions: [
        session("session-1"),
        session("old-session", { date: "2026-04-01" }),
        session("canceled-session", { status: "canceled" }),
      ],
      students: [
        student("active-white", {
          program_memberships: [
            {
              id: "membership-1",
              studio_id: "studio-1",
              student_id: "active-white",
              program_id: "kids",
              program_name: "Kids BJJ",
              status: "active",
              current_belt_rank_id: "white-stripe",
              current_belt_rank_name: "White Stripe",
              created_at: "2026-05-24T00:00:00.000Z",
              updated_at: "2026-05-24T00:00:00.000Z",
            },
          ],
        }),
        student("canceled-blue", {
          status: "canceled",
          current_belt_rank_id: "blue",
        }),
        student("inactive-none", {
          status: "inactive",
          program_id: null,
        }),
      ],
      today: "2026-05-24",
    });

    assert.equal(result.classUtilization[0].label, "Kids BJJ");
    assert.deepEqual(
      result.classUtilization[0].rows.map((row) => [row.label, row.value, row.detail]),
      [["White", "50%", "1 check-ins / 2 seats"], ["Blue", "50%", "1 check-ins / 2 seats"]]
    );
    assert.equal(result.classUtilization[0].rows[0].children[0].label, "White Stripe");
    assert.equal(result.readyToTest[0].rows[0].label, "White");
    assert.equal(result.readyToTest[0].rows[0].value, 1);
    assert.equal(result.readyToTest[0].rows[0].detail, "1 student ready to test");
    assert.equal(result.cancellations[0].rows[0].label, "Blue");
    assert.equal(result.cancellations[0].rows[0].detail, "1 canceled student");
    assert.match(result.churnWatch[0].rows.find((row) => row.label === "Blue")?.detail ?? "", /0 inactive \u00b7 1 canceled/);
  });
});
