import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPreviewStudentImportResult } from "../src/lib/student-import-store-model.ts";

function program(id, name) {
  return {
    id,
    studio_id: "mock-studio",
    name,
    color_hex: "#38BDF8",
    sort_order: 0,
    is_system: false,
    archived_at: null,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    usage: {
      student_count: 0,
      active_student_count: 0,
      class_count: 0,
      active_class_count: 0,
      lead_count: 0,
      belt_ladder_count: 1,
    },
  };
}

function rank(id, name, displayOrder, isTip = false) {
  return {
    id,
    ladder_id: "ladder-bjj",
    studio_id: "mock-studio",
    name,
    color_hex: "#FFFFFF",
    display_order: displayOrder,
    min_classes: 0,
    min_months: 0,
    requires_approval: false,
    is_tip: isTip,
    tip_color_hex: isTip ? "#111827" : undefined,
    created_at: "2026-05-01T00:00:00.000Z",
  };
}

function idFactory() {
  const ids = ["student-import-1", "student-import-2"];
  let index = 0;
  return () => ids[index++] ?? `student-import-${index}`;
}

describe("preview import resolution", () => {
  it("builds preview import results from CSV display values without assigning display text to id fields", () => {
    const white = rank("rank-white", "White Belt", 0);
    const stripeOne = rank("rank-stripe-1", "Stripe 1", 1, true);
    const execution = buildPreviewStudentImportResult({
      rows: [
        {
          Name: "Ari Lane",
          Program: "Brazilian Jiu Jitsu",
          Belt: "Stripe 1",
          Status: "current",
          "Coach Notes": "Strong guard",
          "Office Notes": "Paid cash",
          Tags: "trial, vip",
        },
        {
          Name: "Bo Kim",
          Program: "Unmatched Program",
          Belt: "Unknown Belt",
          Status: "mystery",
        },
      ],
      mapping: {
        Name: "full_name",
        Program: "program_id",
        Belt: "current_belt_rank_id",
        Status: "status",
        "Coach Notes": "notes",
        "Office Notes": "notes",
        Tags: "tags",
      },
      options: {
        create_missing_programs: false,
        create_missing_belts: false,
        import_without_unresolved_belt: true,
        status_alias_mode: "normalize",
      },
      programs: [program("program-bjj", "Brazilian Jiu Jitsu")],
      beltLadders: [{
        id: "ladder-bjj",
        studio_id: "mock-studio",
        name: "BJJ",
        program_id: "program-bjj",
        sub_rank_term: "Stripe",
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
        ranks: [white, stripeOne],
      }],
      fallbackRanks: [white, stripeOne],
      existingStudents: [],
      idFactory: idFactory(),
      now: () => new Date("2026-05-24T12:00:00.000Z"),
      nowMs: () => new Date("2026-05-24T12:00:00.000Z").getTime(),
    });

    assert.equal(execution.importedStudents.length, 1);
    assert.equal(execution.result.total_rows, 2);
    assert.equal(execution.result.valid_rows, 1);
    assert.equal(execution.result.error_rows, 1);
    assert.equal(execution.result.imported_count, 1);
    assert.equal(execution.result.normalized_status_count, 1);
    assert.deepEqual(execution.result.warnings[0].row_numbers, [2]);

    const [student] = execution.students;
    assert.equal(student.id, "student-import-1");
    assert.equal(student.legal_first_name, "Ari");
    assert.equal(student.legal_last_name, "Lane");
    assert.equal(student.program_id, "program-bjj");
    assert.equal(student.current_belt_rank_id, "rank-stripe-1");
    assert.notEqual(student.program_id, "Brazilian Jiu Jitsu");
    assert.notEqual(student.current_belt_rank_id, "Stripe 1");
    assert.equal(student.status, "active");
    assert.equal(student.notes, "Coach Notes: Strong guard\nOffice Notes: Paid cash");
    assert.deepEqual(student.tags, ["trial", "vip"]);

    assert.deepEqual(
      execution.result.rows[1].issues.map((issue) => issue.code),
      ["invalid_status", "unresolved_program", "unresolved_belt"]
    );
  });
});
