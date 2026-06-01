import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAuthUserProfile,
  buildDeferredScheduleDateRange,
  buildLegacyBootstrapResponse,
  buildSessionUserProfile,
  isDashboardSummaryForStudio,
  isLiveAuthRequestCurrent,
  resolveBootstrapLadders,
  resolveBootstrapStudioName,
} from "../src/lib/store-bootstrap-model.ts";

function ladder(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    name: id,
    sub_rank_term: "Stripe",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ranks: [],
    ...overrides,
  };
}

function program(id) {
  return {
    id,
    studio_id: "studio-1",
    name: id,
    color_hex: "#38BDF8",
    sort_order: 0,
    is_system: false,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    usage: {
      student_count: 0,
      active_student_count: 0,
      class_count: 0,
      active_class_count: 0,
      lead_count: 0,
      belt_ladder_count: 0,
    },
  };
}

function lead(id) {
  return {
    id,
    studio_id: "studio-1",
    first_name: "Ari",
    last_name: "Stone",
    source: "walk_in",
    stage: "inquiry",
    is_minor: false,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
  };
}

function student(id) {
  return {
    id,
    studio_id: "studio-1",
    legal_first_name: "Ava",
    legal_last_name: "Lane",
    status: "active",
    tags: [],
    guardians: [],
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
  };
}

function dashboardSummary(studioId) {
  return {
    auth: {
      user: { id: "user-1", email: "owner@example.test" },
      studio_id: studioId,
      role: "admin",
    },
    studio: studioId ? { id: studioId, name: "Studio", timezone: "America/Los_Angeles" } : null,
    generated_at: "2026-05-24T12:00:00.000Z",
    students: { total_students: 0, active_students: 0, trialing_students: 0, on_hold_students: 0 },
    leads: { active_leads: 0, enrolled_leads: 0, due_today_leads: 0 },
    schedule: { today_sessions: 0 },
    belts: { belt_count: 0, tip_count: 0 },
    inactivity: { watch_14: 0, watch_30: 0, watch_90: 0 },
    new_students: { new_14: 0, new_30: 0, new_90: 0, new_year_to_date: 0 },
    operational: {
      attendance_with_capacity: 0,
      total_capacity: 0,
      sessions_tracked: 0,
      sessions_with_capacity: 0,
      utilization_rate: null,
      average_attendance: 0,
    },
    churn: { inactive_students: 0, canceled_students: 0, churn_marked_students: 0, churn_rate: null },
    test_readiness: { ready_to_test: null, needs_approval: null, available: false },
    billing: { can_view_billing: false, payment_attention_count: null, has_plans: null, payments_ready: null },
    setup: {
      has_programs: false,
      has_students: false,
      has_belt_system: false,
      has_weekly_classes: false,
      has_tuition_plans: null,
    },
    recent_students: [],
    actions: [],
  };
}

describe("store bootstrap model", () => {
  it("builds session and auth user profiles from their explicit sources", () => {
    const sessionUser = {
      id: "session-user",
      email: "session@example.test",
      user_metadata: { full_name: "Session User" },
    };

    assert.deepEqual(buildSessionUserProfile(sessionUser), {
      id: "session-user",
      email: "session@example.test",
      full_name: "Session User",
    });
    assert.deepEqual(
      buildAuthUserProfile(
        {
          user: { id: "auth-user", email: "auth@example.test", full_name: null },
          studio_id: "studio-1",
          role: "admin",
        }
      ),
      { id: "auth-user", email: "auth@example.test", full_name: null }
    );
  });

  it("resolves bootstrap studio names and ladders with the same fallback order as the store", () => {
    assert.equal(resolveBootstrapStudioName({ studio_name: "Preferred", studio: { name: "Fallback" } }), "Preferred");
    assert.equal(resolveBootstrapStudioName({ studio_name: null, studio: { name: "Fallback" } }), "Fallback");
    assert.equal(resolveBootstrapStudioName({ studio_name: null, studio: null }), "");

    const primary = ladder("primary");
    assert.deepEqual(
      resolveBootstrapLadders({ belt_ladders: [ladder("existing")], primary_belt_ladder: primary }).map((item) => item.id),
      ["existing"]
    );
    assert.deepEqual(
      resolveBootstrapLadders({ belt_ladders: [], primary_belt_ladder: primary }).map((item) => item.id),
      ["primary"]
    );
    assert.deepEqual(resolveBootstrapLadders({ belt_ladders: [], primary_belt_ladder: null }), []);
  });

  it("builds the legacy bootstrap response from fallback endpoint results", () => {
    const ladders = [ladder("ladder-1")];
    const response = buildLegacyBootstrapResponse({
      auth: { user: { id: "user-1", email: "owner@example.test" }, studio_id: "studio-1", role: "admin" },
      studio: { name: "River City" },
      studentsPage: { items: [student("student-1")], total: 1, page: 1, page_size: 200 },
      programs: [program("program-1")],
      leads: [lead("lead-1")],
      beltLadders: ladders,
    });

    assert.deepEqual(
      {
        studio: response.studio,
        studentIds: response.students.map((item) => item.id),
        programIds: response.programs?.map((item) => item.id),
        leadIds: response.leads.map((item) => item.id),
        ladderIds: response.belt_ladders.map((item) => item.id),
        primaryLadderId: response.primary_belt_ladder?.id,
      },
      {
        studio: { name: "River City" },
        studentIds: ["student-1"],
        programIds: ["program-1"],
        leadIds: ["lead-1"],
        ladderIds: ["ladder-1"],
        primaryLadderId: "ladder-1",
      }
    );
  });

  it("builds deferred schedule windows using the existing UTC ISO date-key behavior", () => {
    assert.deepEqual(buildDeferredScheduleDateRange(new Date("2026-05-24T12:00:00.000Z")), {
      startDate: "2026-04-24",
      endDate: "2026-07-23",
    });
  });

  it("accepts deferred dashboard summaries only for the current studio", () => {
    assert.equal(isDashboardSummaryForStudio(dashboardSummary("studio-1"), "studio-1"), true);
    assert.equal(isDashboardSummaryForStudio(dashboardSummary("studio-2"), "studio-1"), false);
    assert.equal(isDashboardSummaryForStudio(dashboardSummary(null), "studio-1"), false);
  });

  it("accepts live auth request commits only for the same token generation", () => {
    const request = { requestToken: "token-1", requestGeneration: 2 };

    assert.equal(
      isLiveAuthRequestCurrent({ ...request, currentToken: "token-1", currentGeneration: 2 }),
      true
    );
    assert.equal(
      isLiveAuthRequestCurrent({ ...request, currentToken: null, currentGeneration: 3 }),
      false
    );
    assert.equal(
      isLiveAuthRequestCurrent({ ...request, currentToken: "token-2", currentGeneration: 2 }),
      false
    );
    assert.equal(
      isLiveAuthRequestCurrent({ ...request, currentToken: "token-1", currentGeneration: 3 }),
      false
    );
  });
});
