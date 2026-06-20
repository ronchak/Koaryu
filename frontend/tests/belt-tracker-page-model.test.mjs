import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendTipToGroup,
  buildEligibilityGroups,
  buildBeltTrackerProgramState,
  buildLoadNoticeDismissalKey,
  buildNewBeltRank,
  buildNewTipRank,
  buildPromotionRequestBody,
  createLocalRankId,
  deleteRankAndFollowingTips,
  flattenGroups,
  groupRanks,
  isEligibilityEntryReady,
  moveBeltGroup,
  moveTipWithinGroup,
  normalizeSubRankTermDraft,
  updateRankFromForm,
  validatePromotionTarget,
} from "../src/lib/belt-tracker-page-model.ts";

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

function eligibilityEntry(overrides = {}) {
  return {
    student_id: "student-1",
    student_name: "Student One",
    current_rank_id: "white",
    current_rank_name: "White",
    current_rank_color: "#FFFFFF",
    next_rank_id: "blue",
    next_rank_name: "Blue",
    next_rank_color: "#3B82F6",
    classes_since_promo: 0,
    classes_required: 10,
    days_at_rank: 0,
    days_required: 30,
    classes_met: false,
    time_met: false,
    needs_approval: false,
    is_eligible: false,
    ...overrides,
  };
}

function program(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    name: id,
    color_hex: "#111111",
    sort_order: 0,
    is_system: false,
    archived_at: null,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    usage: {},
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

describe("belt tracker page model", () => {
  it("groups tips under the preceding full belt and ignores leading tips", () => {
    const groups = groupRanks([
      rank("orphan-tip", { is_tip: true }),
      rank("white"),
      rank("white-stripe", { is_tip: true }),
      rank("blue"),
      rank("blue-stripe-1", { is_tip: true }),
      rank("blue-stripe-2", { is_tip: true }),
    ]);

    assert.deepEqual(
      groups.map((group) => [group.belt.id, group.tips.map((tip) => tip.id), group.collapsed]),
      [
        ["white", ["white-stripe"], false],
        ["blue", ["blue-stripe-1", "blue-stripe-2"], false],
      ]
    );
  });

  it("flattens groups while rewriting display order", () => {
    const flat = flattenGroups([
      {
        belt: rank("white", { display_order: 9 }),
        tips: [rank("white-stripe", { is_tip: true, display_order: 12 })],
        collapsed: false,
      },
      {
        belt: rank("blue", { display_order: 3 }),
        tips: [],
        collapsed: false,
      },
    ]);

    assert.deepEqual(
      flat.map((item) => [item.id, item.display_order]),
      [["white", 0], ["white-stripe", 1], ["blue", 2]]
    );
  });

  it("moves whole belt groups with their tips", () => {
    const groups = groupRanks([
      rank("white"),
      rank("white-tip", { is_tip: true }),
      rank("blue"),
      rank("blue-tip", { is_tip: true }),
    ]);

    const flat = moveBeltGroup(groups, 0, 1);

    assert.deepEqual(
      flat?.map((item) => [item.id, item.display_order]),
      [["blue", 0], ["blue-tip", 1], ["white", 2], ["white-tip", 3]]
    );
    assert.equal(moveBeltGroup(groups, 0, 0), null);
  });

  it("reorders tips only within their owning belt group", () => {
    const groups = groupRanks([
      rank("white"),
      rank("white-tip-1", { is_tip: true }),
      rank("white-tip-2", { is_tip: true }),
      rank("blue"),
      rank("blue-tip", { is_tip: true }),
    ]);

    const reordered = moveTipWithinGroup(groups, { gIdx: 0, tIdx: 0 }, 0, 1);
    assert.deepEqual(
      reordered?.map((item) => item.id),
      ["white", "white-tip-2", "white-tip-1", "blue", "blue-tip"]
    );

    const crossGroupDrop = moveTipWithinGroup(groups, { gIdx: 0, tIdx: 0 }, 1, 0);
    assert.deepEqual(
      crossGroupDrop?.map((item) => item.id),
      ["white", "white-tip-1", "white-tip-2", "blue", "blue-tip"]
    );
    assert.equal(moveTipWithinGroup(groups, { gIdx: 0, tIdx: 0 }, 0, 0), null);
  });

  it("creates local rank ids with the existing prefix", () => {
    assert.equal(createLocalRankId(0.5), "local-i");
  });

  it("builds rank form mutations without page-local business rules", () => {
    const form = {
      name: "Blue",
      color_hex: "#3B82F6",
      tip_color_hex: "#EF4444",
      min_classes: 20,
      min_months: 3,
      requires_approval: true,
    };
    const belt = buildNewBeltRank({
      data: form,
      displayOrder: 2,
      ladderId: "ladder-1",
      now: "2026-05-24T12:00:00.000Z",
      rankId: "rank-blue",
    });
    const tip = buildNewTipRank({
      beltColorHex: belt.color_hex,
      data: { ...form, name: "Blue Stripe" },
      ladderId: "ladder-1",
      now: "2026-05-24T12:00:00.000Z",
      rankId: "rank-blue-tip",
    });

    assert.equal(belt.is_tip, false);
    assert.equal(belt.display_order, 2);
    assert.equal(belt.tip_color_hex, undefined);
    assert.equal(tip.is_tip, true);
    assert.equal(tip.color_hex, "#3B82F6");
    assert.equal(tip.display_order, 0);

    const withTip = appendTipToGroup(groupRanks([belt]), 0, tip);
    assert.deepEqual(
      withTip?.map((item) => [item.id, item.display_order]),
      [["rank-blue", 0], ["rank-blue-tip", 1]]
    );
    assert.equal(appendTipToGroup(groupRanks([belt]), 4, tip), null);

    const edited = updateRankFromForm([belt, tip], "rank-blue-tip", {
      ...form,
      name: "Blue stripe updated",
      color_hex: "#FFFFFF",
      tip_color_hex: "#22C55E",
      requires_approval: false,
    });
    assert.equal(edited[1].name, "Blue stripe updated");
    assert.equal(edited[1].color_hex, "#FFFFFF");
    assert.equal(edited[1].tip_color_hex, "#22C55E");
    assert.equal(edited[1].requires_approval, false);
  });

  it("normalizes small page-state helper values", () => {
    assert.equal(normalizeSubRankTermDraft(" Tab "), "Tab");
    assert.equal(normalizeSubRankTermDraft("   "), "Stripe");
    assert.equal(buildLoadNoticeDismissalKey("programs", "Failed"), "programs:Failed");
    assert.equal(buildLoadNoticeDismissalKey("programs", null), null);
  });

  it("selects the current ladder program before falling back to the first usable program", () => {
    const state = buildBeltTrackerProgramState({
      beltLadders: [
        ladder("kids-ladder", { program_id: "kids", ranks: [rank("kids-rank")] }),
        ladder("adult-ladder", { program_id: "adults", ranks: [rank("adult-rank")] }),
      ],
      currentLadderId: "adult-ladder",
      programs: [
        program("system", { is_system: true }),
        program("archived", { archived_at: "2026-05-24T00:00:00.000Z" }),
        program("kids", { name: "Kids" }),
        program("adults", { name: "Adults" }),
      ],
      selectedProgramId: null,
      storeBeltRanks: [rank("live-adult-rank")],
    });

    assert.equal(state.selectedProgram?.id, "adults");
    assert.equal(state.currentLadder?.id, "adult-ladder");
    assert.equal(state.currentProgramReady, true);
    assert.deepEqual(state.activeLadderRanks.map((item) => item.id), ["live-adult-rank"]);
    assert.deepEqual(state.beltPrograms.map((item) => item.id), ["kids", "adults"]);
  });

  it("keeps selected program ladder ranks local until the store switches ladders", () => {
    const state = buildBeltTrackerProgramState({
      beltLadders: [
        ladder("kids-ladder", { program_id: "kids", ranks: [rank("kids-rank")] }),
        ladder("adult-ladder", { program_id: "adults", ranks: [rank("adult-rank")] }),
      ],
      currentLadderId: "adult-ladder",
      programs: [program("kids"), program("adults")],
      selectedProgramId: "kids",
      storeBeltRanks: [rank("live-adult-rank")],
    });

    assert.equal(state.selectedProgram?.id, "kids");
    assert.equal(state.currentLadder?.id, "kids-ladder");
    assert.equal(state.currentProgramReady, false);
    assert.deepEqual(state.activeLadderRanks.map((item) => item.id), ["kids-rank"]);
  });

  it("deletes a full belt with following tips and rewrites display order", () => {
    const ranks = [
      rank("white", { display_order: 0 }),
      rank("white-tip-1", { is_tip: true, display_order: 1 }),
      rank("white-tip-2", { is_tip: true, display_order: 2 }),
      rank("blue", { display_order: 3 }),
      rank("blue-tip", { is_tip: true, display_order: 4 }),
    ];

    assert.deepEqual(
      deleteRankAndFollowingTips(ranks, "white").map((item) => [item.id, item.display_order]),
      [["blue", 0], ["blue-tip", 1]]
    );
    assert.deepEqual(
      deleteRankAndFollowingTips(ranks, "blue-tip").map((item) => [item.id, item.display_order]),
      [["white", 0], ["white-tip-1", 1], ["white-tip-2", 2], ["blue", 3]]
    );
    assert.strictEqual(deleteRankAndFollowingTips(ranks, "missing"), ranks);
  });

  it("groups eligibility entries by current rank with route sorting and readiness counts", () => {
    const ranks = [
      rank("white", { name: "White", color_hex: "#FFFFFF" }),
      rank("blue", { name: "Blue", color_hex: "#3B82F6" }),
    ];
    const groups = buildEligibilityGroups(
      [
        eligibilityEntry({
          student_id: "progress",
          student_name: "Progress Student",
          classes_since_promo: 4,
          days_at_rank: 10,
        }),
        eligibilityEntry({
          student_id: "ready",
          student_name: "Ready Student",
          classes_since_promo: 10,
          days_at_rank: 30,
          classes_met: true,
          time_met: true,
          is_eligible: true,
        }),
        eligibilityEntry({
          student_id: "approval",
          student_name: "Approval Student",
          classes_since_promo: 10,
          days_at_rank: 30,
          classes_met: true,
          time_met: true,
          needs_approval: true,
          is_eligible: true,
        }),
        eligibilityEntry({
          student_id: "unranked",
          student_name: "Unranked Student",
          current_rank_id: undefined,
          current_rank_name: undefined,
          current_rank_color: undefined,
        }),
      ],
      ranks
    );

    assert.deepEqual(groups.map((group) => group.key), ["unranked", "white"]);
    assert.equal(groups[0].label, "Unranked");
    assert.deepEqual(groups[1].entries.map((entry) => entry.student_id), [
      "approval",
      "ready",
      "progress",
    ]);
    assert.equal(groups[1].eligibleCount, 1);
    assert.equal(groups[1].approvalCount, 1);
    assert.equal(isEligibilityEntryReady(groups[1].entries[0]), true);
    assert.equal(isEligibilityEntryReady(groups[1].entries[2]), false);
  });

  it("validates promotion targets and builds the live API payload", () => {
    const selectedProgram = program("kids");
    const currentLadder = ladder("kids-ladder", {
      program_id: "kids",
      ranks: [rank("white"), rank("blue")],
    });
    const entry = eligibilityEntry({
      next_rank_id: "blue",
      program_id: "kids",
      student_program_membership_id: "membership-1",
    });

    assert.equal(validatePromotionTarget({
      currentLadder,
      promoteEntry: entry,
      selectedProgram,
    }), null);
    assert.deepEqual(buildPromotionRequestBody(entry, "blue", "  Strong basics  "), {
      student_id: "student-1",
      to_rank_id: "blue",
      student_program_membership_id: "membership-1",
      program_id: "kids",
      notes: "Strong basics",
    });
    assert.equal(buildPromotionRequestBody(entry, "blue", "   ").notes, undefined);
    assert.equal(validatePromotionTarget({
      currentLadder,
      promoteEntry: eligibilityEntry({ next_rank_id: null }),
      selectedProgram,
    }), "Could not determine the next rank for this promotion.");
    assert.equal(validatePromotionTarget({
      currentLadder,
      promoteEntry: eligibilityEntry({ next_rank_id: "purple" }),
      selectedProgram,
    }), "This promotion target is not part of the current belt ladder.");
    assert.equal(validatePromotionTarget({
      currentLadder,
      promoteEntry: eligibilityEntry({ next_rank_id: "blue", program_id: "adults" }),
      selectedProgram,
    }), "This student is queued in a different program. Switch programs before promoting.");
  });
});
