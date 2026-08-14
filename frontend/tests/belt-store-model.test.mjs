import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beltLadderMatchesSyncPayload,
  buildBeltLadderSyncPayload,
  buildPreviewBeltLadderFromRanks,
  buildPreviewPromotion,
  repairPreviewStudentRanksForLadder,
  selectBeltLadder,
  sortBeltLadders,
  updatePreviewLadderSubRankTerm,
  upsertBeltLadder,
} from "../src/lib/belt-store-model.ts";

function rank(id, overrides = {}) {
  return {
    id,
    ladder_id: "ladder-1",
    studio_id: "mock-studio",
    name: id,
    color_hex: "#FFFFFF",
    display_order: 0,
    min_classes: 0,
    min_months: 0,
    requires_approval: false,
    is_tip: false,
    created_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function ladder(id, overrides = {}) {
  return {
    id,
    studio_id: "mock-studio",
    name: id,
    sub_rank_term: "Stripe",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ranks: [],
    ...overrides,
  };
}

function student(id, overrides = {}) {
  return {
    id,
    studio_id: "mock-studio",
    legal_first_name: "Ava",
    legal_last_name: "Lane",
    status: "active",
    tags: [],
    guardians: [],
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("belt store model", () => {
  it("selects, sorts, and upserts ladders deterministically", () => {
    const late = ladder("late", { created_at: "2026-05-03T00:00:00.000Z" });
    const early = ladder("early", { created_at: "2026-05-01T00:00:00.000Z" });

    assert.equal(selectBeltLadder([late, early], "early")?.id, "early");
    assert.equal(selectBeltLadder([late, early], "missing")?.id, "late");
    assert.deepEqual(sortBeltLadders([late, early]).map((item) => item.id), ["early", "late"]);
    assert.deepEqual(
      upsertBeltLadder([late, early], ladder("late", { name: "Updated", created_at: "2026-05-02T00:00:00.000Z" }))
        .map((item) => [item.id, item.name]),
      [
        ["early", "early"],
        ["late", "Updated"],
      ]
    );
  });

  it("builds the preview ladder rank update from selected or fallback ladder state", () => {
    const builtFromSelected = buildPreviewBeltLadderFromRanks(
      [
        ladder("kids", { name: "Kids", sub_rank_term: "Tip" }),
        ladder("adults", { name: "Adults" }),
      ],
      [rank("white")],
      {
        preferredLadderId: "kids",
        fallbackLadder: ladder("fallback", { name: "Fallback" }),
        ladderName: "Current Name",
        subRankTerm: "Stripe",
        requestedSubRankTerm: " Tape ",
      }
    );

    assert.deepEqual(
      [builtFromSelected.id, builtFromSelected.name, builtFromSelected.sub_rank_term, builtFromSelected.ranks[0].id],
      ["kids", "Kids", "Tape", "white"]
    );

    const builtFromFallback = buildPreviewBeltLadderFromRanks([], [rank("blue")], {
      fallbackLadder: ladder("fallback", { name: "Fallback" }),
      ladderName: "Display Name",
      subRankTerm: "Stripe",
    });
    assert.deepEqual(
      [builtFromFallback.id, builtFromFallback.name, builtFromFallback.sub_rank_term, builtFromFallback.ranks[0].id],
      ["mock-ladder", "Display Name", "Stripe", "blue"]
    );
  });

  it("builds the live belt sync payload without sending local-only rank ids", () => {
    const payload = buildBeltLadderSyncPayload(
      [
        rank("rank-1", { name: "White", display_order: 9, is_tip: false, tip_color_hex: "#000000" }),
        rank("local-rank-2", { name: "Black Tip", is_tip: true, tip_color_hex: "#111111", requires_approval: true }),
      ],
      "Stripe"
    );

    assert.deepEqual(payload, {
      sub_rank_term: "Stripe",
      ranks: [
        {
          id: "rank-1",
          name: "White",
          color_hex: "#FFFFFF",
          display_order: 0,
          min_classes: 0,
          min_months: 0,
          requires_approval: false,
          is_tip: false,
          tip_color_hex: null,
        },
        {
          name: "Black Tip",
          color_hex: "#FFFFFF",
          display_order: 1,
          min_classes: 0,
          min_months: 0,
          requires_approval: true,
          is_tip: true,
          tip_color_hex: "#111111",
        },
      ],
    });
  });

  it("recognizes an exact authoritative ladder after an ambiguous sync response", () => {
    const payload = buildBeltLadderSyncPayload(
      [rank("local-new-rank", { name: "White", color_hex: "#FFFFFF" })],
      "Tip",
    );
    const committed = {
      ...ladder("ladder-1", { sub_rank_term: "Tip" }),
      ranks: [rank("11111111-1111-4111-8111-111111111111", { name: "White", color_hex: "#ffffff" })],
    };

    assert.equal(beltLadderMatchesSyncPayload(committed, payload), true);
    assert.equal(
      beltLadderMatchesSyncPayload(
        { ...committed, ranks: [rank("22222222-2222-4222-8222-222222222222", { name: "Blue" })] },
        payload,
      ),
      false,
    );
  });

  it("updates preview sub-rank term only when a ladder is selected", () => {
    const updated = updatePreviewLadderSubRankTerm(
      [ladder("adults", { sub_rank_term: "Stripe" })],
      "adults",
      "Tip"
    );

    assert.equal(updated.selectedLadder?.id, "adults");
    assert.deepEqual(updated.ladders?.map((item) => [item.id, item.sub_rank_term]), [["adults", "Tip"]]);

    const missing = updatePreviewLadderSubRankTerm([], null, "Tip");
    assert.equal(missing.selectedLadder, null);
    assert.equal(missing.ladders, null);
  });

  it("builds preview promotions and applies the student rank update", () => {
    const result = buildPreviewPromotion(
      [
        student("student-1", {
          preferred_name: "A",
          program_id: "bjj",
          current_belt_rank_id: "white",
          program_memberships: [
            {
              id: "membership-1",
              studio_id: "mock-studio",
              student_id: "student-1",
              program_id: "bjj",
              status: "paused",
              started_at: "2026-05-01",
              current_belt_rank_id: "white",
              created_at: "2026-05-01T00:00:00.000Z",
              updated_at: "2026-05-01T00:00:00.000Z",
            },
          ],
        }),
        student("student-2", { current_belt_rank_id: "white" }),
      ],
      [rank("white", { name: "White" }), rank("blue", { name: "Blue" })],
      {
        studentId: "student-1",
        toRankId: "blue",
        notes: "Ready",
        idFactory: () => "promotion-1",
        now: new Date("2026-05-24T12:00:00.000Z"),
      }
    );

    assert.deepEqual(
      {
        id: result.promotion.id,
        from_rank_id: result.promotion.from_rank_id,
        to_rank_id: result.promotion.to_rank_id,
        promoted_by: result.promotion.promoted_by,
        student_name: result.promotion.student_name,
        from_rank_name: result.promotion.from_rank_name,
        to_rank_name: result.promotion.to_rank_name,
        notes: result.promotion.notes,
        promoted_at: result.promotion.promoted_at,
      },
      {
        id: "promotion-1",
        from_rank_id: "white",
        to_rank_id: "blue",
        promoted_by: "preview-user",
        student_name: "A",
        from_rank_name: "White",
        to_rank_name: "Blue",
        notes: "Ready",
        promoted_at: "2026-05-24T12:00:00.000Z",
      }
    );
    assert.deepEqual(result.students.map((item) => [item.id, item.current_belt_rank_id, item.updated_at]), [
      ["student-1", "blue", "2026-05-24T12:00:00.000Z"],
      ["student-2", "white", "2026-05-01T00:00:00.000Z"],
    ]);
    assert.deepEqual(
      result.students[0].program_memberships?.map((membership) => [
        membership.id,
        membership.current_belt_rank_id,
        membership.updated_at,
      ]),
      [["membership-1", "blue", "2026-05-24T12:00:00.000Z"]]
    );
    assert.equal(result.students[0].program_memberships?.[0]?.status, "paused");
  });

  it("keeps preview promotion validation errors explicit", () => {
    assert.throws(
      () => buildPreviewPromotion([], [rank("blue")], {
        studentId: "missing",
        toRankId: "blue",
        idFactory: () => "promotion-1",
      }),
      /Student not found/
    );

    assert.throws(
      () => buildPreviewPromotion([student("student-1")], [], {
        studentId: "student-1",
        toRankId: "missing",
        idFactory: () => "promotion-1",
      }),
      /Target rank not found/
    );
  });

  it("promotes the exact unranked secondary program membership", () => {
    const result = buildPreviewPromotion(
      [student("student-1", {
        program_id: "primary-program",
        current_belt_rank_id: "primary-white",
        program_memberships: [
          {
            id: "primary-membership",
            studio_id: "mock-studio",
            student_id: "student-1",
            program_id: "primary-program",
            status: "active",
            started_at: "2026-05-01",
            current_belt_rank_id: "primary-white",
            created_at: "2026-05-01T00:00:00.000Z",
            updated_at: "2026-05-01T00:00:00.000Z",
          },
          {
            id: "secondary-membership",
            studio_id: "mock-studio",
            student_id: "student-1",
            program_id: "secondary-program",
            status: "active",
            started_at: "2026-05-10",
            current_belt_rank_id: null,
            created_at: "2026-05-10T00:00:00.000Z",
            updated_at: "2026-05-10T00:00:00.000Z",
          },
        ],
      })],
      [
        rank("primary-white", { ladder_id: "primary-ladder", name: "White" }),
        rank("secondary-white", { ladder_id: "secondary-ladder", name: "Secondary White" }),
      ],
      {
        studentId: "student-1",
        toRankId: "secondary-white",
        studentProgramMembershipId: "secondary-membership",
        programId: "secondary-program",
        idFactory: () => "promotion-1",
      }
    );

    assert.equal(result.promotion.student_program_membership_id, "secondary-membership");
    assert.equal(result.promotion.program_id, "secondary-program");
    assert.equal(result.promotion.from_rank_id, null);
    assert.equal(result.students[0].current_belt_rank_id, "primary-white");
    assert.deepEqual(
      result.students[0].program_memberships.map((membership) => [
        membership.id,
        membership.current_belt_rank_id,
      ]),
      [
        ["primary-membership", "primary-white"],
        ["secondary-membership", "secondary-white"],
      ]
    );
  });

  it("repairs deleted preview ranks to the nearest surviving full belt", () => {
    const previewLadder = ladder("ladder-1", { program_id: "bjj" });
    const white = rank("white", { display_order: 0 });
    const yellow = rank("yellow", { display_order: 1 });
    const repaired = repairPreviewStudentRanksForLadder(
      [student("student-1", {
        program_id: "bjj",
        current_belt_rank_id: "yellow",
        program_memberships: [{
          id: "membership-1",
          studio_id: "mock-studio",
          student_id: "student-1",
          program_id: "bjj",
          status: "active",
          started_at: "2026-05-01",
          current_belt_rank_id: "yellow",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:00.000Z",
        }],
      })],
      previewLadder,
      [white, yellow],
      [white],
      new Date("2026-05-24T12:00:00.000Z"),
    );

    assert.equal(repaired[0].current_belt_rank_id, "white");
    assert.equal(repaired[0].program_memberships[0].current_belt_rank_id, "white");
    assert.equal(repaired[0].program_memberships[0].updated_at, "2026-05-24T12:00:00.000Z");
  });

  it("assigns the first new full belt without overwriting deliberate unranked state", () => {
    const previewLadder = ladder("ladder-1", { program_id: "bjj" });
    const white = rank("white", { display_order: 0 });
    const unrankedStudent = student("student-1", {
      program_id: "bjj",
      current_belt_rank_id: null,
      program_memberships: [{
        id: "membership-1",
        studio_id: "mock-studio",
        student_id: "student-1",
        program_id: "bjj",
        status: "active",
        started_at: "2026-05-01",
        current_belt_rank_id: null,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      }],
    });

    const initiallyAssigned = repairPreviewStudentRanksForLadder(
      [unrankedStudent],
      previewLadder,
      [],
      [white],
    );
    assert.equal(initiallyAssigned[0].program_memberships[0].current_belt_rank_id, "white");

    const deliberatelyUnranked = repairPreviewStudentRanksForLadder(
      [unrankedStudent],
      previewLadder,
      [white],
      [white, rank("yellow", { display_order: 1 })],
    );
    assert.equal(deliberatelyUnranked[0].program_memberships[0].current_belt_rank_id, null);
  });
});
