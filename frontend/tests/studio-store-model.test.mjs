import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPreviewDemoResetResponse,
  buildPreviewHydratedLadderState,
  buildPreviewStudioDataClearResponse,
  resolvePreviewLadderHydrationDefaults,
} from "../src/lib/studio-store-model.ts";

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
    ranks: [rank(`${id}-rank`)],
    ...overrides,
  };
}

function student(id) {
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
  };
}

function lead(id) {
  return {
    id,
    studio_id: "mock-studio",
    first_name: "Ari",
    last_name: "Stone",
    source: "walk_in",
    stage: "inquiry",
    is_minor: false,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
  };
}

function session(id) {
  return {
    id,
    studio_id: "mock-studio",
    name: id,
    date: "2026-05-24",
    start_time: "17:00",
    end_time: "18:00",
    status: "scheduled",
    created_at: "2026-05-01T00:00:00.000Z",
    attendance_count: 0,
  };
}

function attendance(id) {
  return {
    id,
    studio_id: "mock-studio",
    session_id: "session-1",
    student_id: "student-1",
    status: "present",
    checked_in_at: "2026-05-24T17:00:00.000Z",
  };
}

describe("studio store model", () => {
  it("resolves preview ladder hydration defaults from stored ladders or demo defaults", () => {
    const adult = ladder("adult", { name: "Adults", sub_rank_term: "Tape" });
    const kids = ladder("kids", { name: "Kids", sub_rank_term: "Tip" });
    const fallback = ladder("fallback", { name: "Fallback" });
    const resolved = resolvePreviewLadderHydrationDefaults({
      storedLadders: [adult, kids],
      currentLadderId: "kids",
      fallbackLadders: [fallback],
      fallbackLadder: fallback,
    });

    assert.deepEqual(
      {
        ladderIds: resolved.previewLadders.map((item) => item.id),
        selectedId: resolved.selectedPreviewLadder?.id,
        defaultRankIds: resolved.defaultRanks.map((item) => item.id),
        defaultSubRankTerm: resolved.defaultSubRankTerm,
        defaultLadderName: resolved.defaultLadderName,
      },
      {
        ladderIds: ["adult", "kids"],
        selectedId: "kids",
        defaultRankIds: ["kids-rank"],
        defaultSubRankTerm: "Tip",
        defaultLadderName: "Kids",
      }
    );

    const fallbackResolved = resolvePreviewLadderHydrationDefaults({
      storedLadders: [],
      currentLadderId: null,
      fallbackLadders: [fallback],
      fallbackLadder: fallback,
    });
    assert.deepEqual(
      [fallbackResolved.previewLadders[0].id, fallbackResolved.selectedPreviewLadder?.id],
      ["fallback", "fallback"]
    );
  });

  it("hydrates only the selected preview ladder with persisted rank display values", () => {
    const adult = ladder("adult", { name: "Adults" });
    const kids = ladder("kids", { name: "Kids" });
    const hydrated = buildPreviewHydratedLadderState({
      previewLadders: [adult, kids],
      selectedPreviewLadder: kids,
      storedRanks: [rank("persisted")],
      storedSubRankTerm: "Chevron",
      storedLadderName: "Youth",
      primaryEligibilityLadderId: "adult",
      primaryEligibilityRows: [{ student_id: "student-1", student_name: "Ava", classes_since_promo: 0, classes_required: 0, days_at_rank: 0, days_required: 0, classes_met: true, time_met: true, needs_approval: false, is_eligible: true }],
    });

    assert.deepEqual(
      hydrated.hydratedLadders.map((item) => [item.id, item.name, item.sub_rank_term, item.ranks[0].id]),
      [
        ["adult", "Adults", "Stripe", "adult-rank"],
        ["kids", "Youth", "Chevron", "persisted"],
      ]
    );
    assert.deepEqual(
      [hydrated.eligibilityLadderId, hydrated.eligibilityRows.length],
      ["kids", 0]
    );
  });

  it("builds the preview demo reset response with fixture counts and sorted sessions", () => {
    const response = buildPreviewDemoResetResponse({
      studioName: "River City Martial Arts",
      programs: [],
      students: [student("student-1")],
      leads: [lead("lead-1")],
      beltLadders: [ladder("primary", { ranks: [rank("white"), rank("blue")] })],
      primaryBeltLadder: ladder("primary", { ranks: [rank("white"), rank("blue")] }),
      eligibility: [],
      templates: [],
      sessions: [
        { ...session("late"), date: "2026-05-24", start_time: "18:00" },
        { ...session("early"), date: "2026-05-24", start_time: "10:00" },
      ],
      attendance: [attendance("attendance-1")],
    });
    const sessionOrder = response.sessions.map((item) => `${item.date} ${item.start_time}`);

    assert.equal(response.studio_name, "River City Martial Arts");
    assert.equal(response.counts.students, response.students.length);
    assert.equal(response.counts.leads, response.leads.length);
    assert.equal(response.counts.class_sessions, response.sessions.length);
    assert.equal(response.counts.attendance_records, response.attendance.length);
    assert.equal(response.primary_belt_ladder?.id, response.belt_ladders[0].id);
    assert.deepEqual(sessionOrder, [...sessionOrder].sort());
  });

  it("builds preview clear responses from current in-memory counts", () => {
    const response = buildPreviewStudioDataClearResponse({
      studioName: "",
      students: [student("student-1"), student("student-2")],
      leads: [lead("lead-1")],
      beltRanks: [rank("white"), rank("blue"), rank("purple")],
      sessions: [session("session-1")],
      attendance: [attendance("attendance-1"), attendance("attendance-2")],
    });

    assert.deepEqual(response, {
      studio_name: "My Studio",
      counts: {
        students: 2,
        leads: 1,
        belt_ranks: 3,
        class_sessions: 1,
        attendance_records: 2,
      },
    });
  });
});
