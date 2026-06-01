import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SOURCE_LABELS,
  buildLeadUpdateSuccessMessage,
  buildLeadsPageModel,
  buildOptimisticLeadUpdate,
  formatDate,
  fullName,
  getDueFollowUpQueue,
  getDueTodayCount,
  getFollowUpStatusLabel,
  getLeadFollowUpInputValue,
  getLostLeads,
  getNextStage,
  getProgramLabel,
  getStageLabel,
  getUpcomingFollowUpCount,
  groupLeadsByStage,
  mergeOptimisticLeads,
  removeOptimisticLeadUpdate,
  timeAgo,
} from "../src/lib/leads-page-model.ts";

function lead(overrides = {}) {
  return {
    id: "lead-1",
    studio_id: "studio-1",
    first_name: "Ava",
    last_name: "Nguyen",
    stage: "inquiry",
    source: "website",
    follow_up_date: null,
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

describe("leads page model", () => {
  it("keeps pipeline stage labels and next-stage transitions deterministic", () => {
    assert.equal(getNextStage("inquiry"), "trial_scheduled");
    assert.equal(getNextStage("enrolled"), null);
    assert.equal(getNextStage("closed_lost"), null);
    assert.equal(getStageLabel("offer_sent"), "Offer Sent");
    assert.equal(getStageLabel("closed_lost"), "Closed Lost");
    assert.equal(SOURCE_LABELS.referral, "Referral");
  });

  it("formats lead names, dates, and follow-up status copy", () => {
    assert.equal(fullName(lead({ first_name: "Kai", last_name: "Rivera" })), "Kai Rivera");
    assert.equal(formatDate("2026-05-24"), "May 24");
    assert.equal(formatDate("2026-05-24", true), "May 24, 2026");
    assert.equal(timeAgo("2026-05-23T12:00:00.000Z", Date.parse("2026-05-24T12:00:00.000Z")), "Yesterday");
    assert.equal(getFollowUpStatusLabel("2026-05-24", "2026-05-24"), "Due today");
    assert.equal(getFollowUpStatusLabel("2026-05-22", "2026-05-24"), "2d overdue");
    assert.equal(getFollowUpStatusLabel("2026-05-26", "2026-05-24"), "Due May 26");
  });

  it("builds lead pipeline buckets and follow-up queues outside the route", () => {
    const leads = [
      lead({ id: "future", stage: "inquiry", follow_up_date: "2026-05-26" }),
      lead({ id: "due", stage: "trial_scheduled", follow_up_date: "2026-05-24" }),
      lead({ id: "overdue", stage: "offer_sent", follow_up_date: "2026-05-22" }),
      lead({ id: "lost", stage: "closed_lost", follow_up_date: "2026-05-20" }),
      lead({ id: "enrolled", stage: "enrolled", follow_up_date: "2026-05-20" }),
    ];

    const buckets = groupLeadsByStage(leads);
    assert.deepEqual(buckets.inquiry.map((item) => item.id), ["future"]);
    assert.equal(buckets.closed_lost, undefined);
    assert.deepEqual(getLostLeads(leads).map((item) => item.id), ["lost"]);

    const queue = getDueFollowUpQueue(leads, "2026-05-24");
    assert.deepEqual(queue.map((item) => item.id), ["overdue", "due"]);
    assert.equal(getDueTodayCount(queue, "2026-05-24"), 1);
    assert.equal(getUpcomingFollowUpCount(leads, "2026-05-24"), 1);
  });

  it("merges optimistic lead state and derives program fallback labels", () => {
    const base = [
      lead({ id: "lead-1", first_name: "Base", program_interest: "Kids BJJ" }),
      lead({ id: "lead-2", first_name: "Second" }),
    ];
    const optimistic = {
      "lead-1": lead({ id: "lead-1", first_name: "Updated", program_interest: "Adults" }),
    };

    assert.deepEqual(
      mergeOptimisticLeads(base, optimistic).map((item) => [item.id, item.first_name]),
      [["lead-1", "Updated"], ["lead-2", "Second"]]
    );
    assert.equal(getProgramLabel(base[0], null), "Kids BJJ");
    assert.equal(getProgramLabel(base[1], { name: "Competition Team" }), "Competition Team");
    assert.equal(getProgramLabel(lead({ program_interest: "" }), null), "No program");
  });

  it("builds page-level lead state from stores without route-local duplication", () => {
    const model = buildLeadsPageModel({
      baseLeads: [
        lead({ id: "lead-1", first_name: "Base", follow_up_date: "2026-05-24" }),
        lead({ id: "lead-2", stage: "trial_scheduled", follow_up_date: "2026-05-22" }),
        lead({ id: "lead-3", stage: "enrolled", follow_up_date: "2026-05-20" }),
        lead({ id: "lead-4", stage: "closed_lost" }),
      ],
      draggedLeadId: "lead-2",
      optimisticLeads: {
        "lead-1": lead({
          id: "lead-1",
          first_name: "Optimistic",
          stage: "offer_sent",
          follow_up_date: "2026-05-24",
        }),
      },
      programs: [
        program({ id: "active-program", name: "Active Program" }),
        program({ id: "archived-program", name: "Archived Program", archived_at: "2026-05-01T00:00:00.000Z" }),
      ],
      selectedLeadId: "lead-1",
      today: "2026-05-24",
    });

    assert.deepEqual(model.activePrograms.map((item) => item.id), ["active-program"]);
    assert.equal(model.programById.get("archived-program")?.name, "Archived Program");
    assert.equal(model.selectedLead?.first_name, "Optimistic");
    assert.equal(model.draggedLeadRecord?.id, "lead-2");
    assert.deepEqual(model.leadsByStage.offer_sent?.map((item) => item.id), ["lead-1"]);
    assert.deepEqual(model.lostLeads.map((item) => item.id), ["lead-4"]);
    assert.deepEqual(model.followUpQueue.map((item) => item.id), ["lead-2", "lead-1"]);
    assert.equal(model.dueTodayCount, 1);
    assert.equal(model.overdueCount, 1);
    assert.equal(model.upcomingFollowUps, 0);
    assert.equal(model.totalActive, 3);
    assert.equal(model.enrolledCount, 1);
  });

  it("keeps lead page draft and optimistic update helpers deterministic", () => {
    const original = lead({ id: "lead-1", follow_up_date: "2026-05-25" });
    assert.equal(
      getLeadFollowUpInputValue(original, { "lead-1": "2026-05-26" }, "2026-05-24"),
      "2026-05-26"
    );
    assert.equal(getLeadFollowUpInputValue(original, {}, "2026-05-24"), "2026-05-25");
    assert.equal(
      getLeadFollowUpInputValue(lead({ id: "lead-2", follow_up_date: null }), {}, "2026-05-24"),
      "2026-05-24"
    );

    const optimistic = buildOptimisticLeadUpdate(
      original,
      { stage: "trial_completed", follow_up_date: null },
      "2026-05-24T18:00:00.000Z"
    );
    assert.equal(optimistic.stage, "trial_completed");
    assert.equal(optimistic.follow_up_date, null);
    assert.equal(optimistic.updated_at, "2026-05-24T18:00:00.000Z");

    const optimisticLeads = { "lead-1": optimistic, "lead-2": lead({ id: "lead-2" }) };
    const removed = removeOptimisticLeadUpdate(optimisticLeads, "lead-1");
    assert.deepEqual(Object.keys(removed), ["lead-2"]);
    assert.deepEqual(Object.keys(optimisticLeads), ["lead-1", "lead-2"]);
    assert.strictEqual(removeOptimisticLeadUpdate(removed, "missing"), removed);
  });

  it("centralizes lead update success copy", () => {
    const currentLead = lead({ first_name: "Maya", last_name: "Chen" });
    assert.equal(
      buildLeadUpdateSuccessMessage(currentLead, { stage: "trial_scheduled" }),
      "Maya Chen moved to Trial Scheduled."
    );
    assert.equal(
      buildLeadUpdateSuccessMessage(currentLead, { follow_up_date: null }),
      "Follow-up updated for Maya Chen."
    );
    assert.equal(
      buildLeadUpdateSuccessMessage(currentLead, { notes: "Prefers evenings" }),
      "Maya Chen updated."
    );
  });
});
