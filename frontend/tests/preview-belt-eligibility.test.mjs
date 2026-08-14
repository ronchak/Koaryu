import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPreviewEligibilityForLadder } from "../src/lib/preview-belt-eligibility.ts";

const ranks = [
  {
    id: "white",
    ladder_id: "ladder-bjj",
    studio_id: "mock-studio",
    name: "White Belt",
    color_hex: "#FFFFFF",
    display_order: 0,
    min_classes: 0,
    min_months: 0,
    requires_approval: false,
    is_tip: false,
    created_at: "2026-05-01T00:00:00.000Z",
  },
  {
    id: "yellow",
    ladder_id: "ladder-bjj",
    studio_id: "mock-studio",
    name: "Yellow Belt",
    color_hex: "#EAB308",
    display_order: 1,
    min_classes: 10,
    min_months: 2,
    requires_approval: true,
    is_tip: false,
    created_at: "2026-05-01T00:00:00.000Z",
  },
];

const ladder = {
  id: "ladder-bjj",
  studio_id: "mock-studio",
  name: "BJJ",
  program_id: "program-bjj",
  sub_rank_term: "Stripe",
  ranks,
  created_at: "2026-05-01T00:00:00.000Z",
  updated_at: "2026-05-01T00:00:00.000Z",
};

function student(id, overrides = {}) {
  return {
    id,
    studio_id: "mock-studio",
    legal_first_name: id,
    legal_last_name: "Student",
    status: "active",
    membership_start_date: "2026-05-01",
    program_id: "program-bjj",
    current_belt_rank_id: "white",
    program_memberships: [
      {
        id: `${id}-membership`,
        studio_id: "mock-studio",
        student_id: id,
        program_id: "program-bjj",
        status: "active",
        started_at: "2026-05-01",
        ended_at: null,
        current_belt_rank_id: "white",
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      },
    ],
    tags: [],
    guardians: [],
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("preview belt eligibility", () => {
  it("derives current eligibility from the active program roster", () => {
    const rows = buildPreviewEligibilityForLadder({
      ladderId: ladder.id,
      beltLadders: [ladder],
      beltRanks: ranks,
      students: [
        student("new-student"),
        student("inactive-student", { status: "inactive" }),
        student("other-program", {
          program_id: "program-karate",
          current_belt_rank_id: null,
          program_memberships: [{
            ...student("other-program").program_memberships[0],
            program_id: "program-karate",
            current_belt_rank_id: null,
          }],
        }),
      ],
      nowMs: Date.parse("2026-05-31T00:00:00.000Z"),
    });

    assert.deepEqual(rows.map((row) => row.student_id), ["new-student"]);
    assert.deepEqual(rows[0], {
      student_id: "new-student",
      student_program_membership_id: "new-student-membership",
      program_id: "program-bjj",
      student_name: "new-student Student",
      current_rank_id: "white",
      current_rank_name: "White Belt",
      current_rank_color: "#FFFFFF",
      next_rank_id: "yellow",
      next_rank_name: "Yellow Belt",
      next_rank_color: "#EAB308",
      classes_since_promo: 0,
      classes_required: 10,
      days_at_rank: 30,
      days_required: 60,
      classes_met: false,
      time_met: false,
      needs_approval: true,
      is_eligible: false,
    });
  });

  it("preserves seeded progress only while the student's rank transition still matches", () => {
    const rows = buildPreviewEligibilityForLadder({
      ladderId: ladder.id,
      beltLadders: [ladder],
      beltRanks: ranks,
      students: [student("seeded")],
      seedRows: [{
        student_id: "seeded",
        student_name: "Seeded Student",
        current_rank_id: "white",
        next_rank_id: "yellow",
        classes_since_promo: 12,
        classes_required: 10,
        days_at_rank: 90,
        days_required: 60,
        classes_met: true,
        time_met: true,
        needs_approval: true,
        is_eligible: false,
      }],
    });

    assert.equal(rows[0].classes_since_promo, 12);
    assert.equal(rows[0].days_at_rank, 90);
    assert.equal(rows[0].classes_met, true);
    assert.equal(rows[0].time_met, true);
  });
});
