import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildStudentDetailModel,
  buildStudentEditInitialData,
  getActiveStudentProgramIds,
  isStudentCurrentHold,
  validateStudentPhotoFile,
} from "../src/lib/student-detail-page-model.ts";

function rank(id, overrides = {}) {
  return {
    id,
    ladder_id: "ladder-1",
    studio_id: "studio-1",
    name: id,
    color_hex: "#111111",
    display_order: 0,
    min_classes: 0,
    min_months: 0,
    requires_approval: false,
    is_tip: false,
    created_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function ladder(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    name: id,
    sub_rank_term: "Stripe",
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    ranks: [],
    ...overrides,
  };
}

function student(overrides = {}) {
  return {
    id: "student-1",
    studio_id: "studio-1",
    legal_first_name: "Ava",
    legal_last_name: "Lane",
    preferred_name: "Ace",
    date_of_birth: "2014-05-24",
    is_minor: true,
    status: "active",
    membership_start_date: "2026-01-15",
    hold_start_date: null,
    hold_end_date: null,
    email: "ava@example.test",
    phone: "555-0101",
    address_line1: "1 Main",
    address_city: "Oakland",
    address_state: "CA",
    address_zip: "94601",
    emergency_contact_name: "Gina Lane",
    emergency_contact_phone: "555-0102",
    emergency_contact_relation: "Mother",
    program_id: "kids",
    program_memberships: [],
    current_belt_rank_id: "white",
    notes: "Focused student",
    tags: ["vip"],
    guardians: [
      {
        first_name: "Gina",
        last_name: "Lane",
        email: "gina@example.test",
        phone: "555-0103",
        relation: "Mother",
        is_primary_contact: true,
      },
    ],
    created_at: "2026-01-15T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function promotion(overrides = {}) {
  return {
    id: "promotion-1",
    studio_id: "studio-1",
    student_id: "student-1",
    from_rank_id: null,
    from_rank_name: null,
    to_rank_id: "white",
    to_rank_name: "White",
    promoted_at: "2026-05-20T00:00:00.000Z",
    notes: null,
    ...overrides,
  };
}

describe("student detail page model", () => {
  it("validates profile photo uploads with type and size boundaries", () => {
    assert.equal(validateStudentPhotoFile({ type: "image/jpeg", size: 100 }), null);
    assert.equal(
      validateStudentPhotoFile({ type: "image/gif", size: 100 }),
      "Choose a JPG, PNG, or WebP image."
    );
    assert.equal(
      validateStudentPhotoFile({ type: "image/png", size: 6 * 1024 * 1024 }),
      "Choose an image under 5 MB."
    );
  });

  it("detects current holds from paused status and date windows", () => {
    assert.equal(isStudentCurrentHold(student({ status: "paused" }), "2026-05-24"), true);
    assert.equal(isStudentCurrentHold(student({ hold_start_date: "2026-06-01" }), "2026-05-24"), false);
    assert.equal(isStudentCurrentHold(student({ hold_start_date: "2026-05-01", hold_end_date: null }), "2026-05-24"), true);
    assert.equal(isStudentCurrentHold(student({ hold_start_date: "2026-05-01", hold_end_date: "2026-05-23" }), "2026-05-24"), false);
  });

  it("prefers active memberships over the legacy program id", () => {
    assert.deepEqual(
      getActiveStudentProgramIds(student({
        program_id: "legacy",
        program_memberships: [
          { program_id: "kids", status: "active" },
          { program_id: "ended", status: "ended", ended_at: "2026-05-01" },
        ],
      })),
      ["kids"]
    );
    assert.deepEqual(getActiveStudentProgramIds(student({ program_id: "legacy" })), ["legacy"]);
  });

  it("builds the derived student detail model and edit initial data", () => {
    const detail = buildStudentDetailModel({
      beltLadders: [
        ladder("ladder-1", {
          name: "Kids Ladder",
          program_id: "kids",
          ranks: [
            rank("white", { name: "White", display_order: 0 }),
            rank("blue", { name: "Blue", display_order: 1 }),
          ],
        }),
      ],
      promotionHistory: [promotion()],
      student: student({
        program_memberships: [{ program_id: "kids", status: "active" }],
      }),
      today: "2026-05-24",
    });

    assert.equal(detail.fullName, "Ace Lane");
    assert.equal(detail.primaryGuardian?.email, "gina@example.test");
    assert.equal(detail.currentRank?.name, "White");
    assert.equal(detail.currentRank?.ladderName, "Kids Ladder");
    assert.equal(detail.nextRank?.name, "Blue");
    assert.equal(detail.latestPromotion?.id, "promotion-1");
    assert.deepEqual(detail.editInitialData.program_ids, ["kids"]);
    assert.equal(detail.editInitialData.guardians?.[0]?.is_primary_contact, true);

    const editData = buildStudentEditInitialData(student(), ["kids", "nogi"]);
    assert.deepEqual(editData.program_ids, ["kids", "nogi"]);
    assert.equal(editData.current_belt_rank_id, "white");
  });
});
