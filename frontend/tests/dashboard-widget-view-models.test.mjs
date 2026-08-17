import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDashboardWidgetViewModels } from "../src/lib/dashboard-widget-view-models.ts";
import { readDashboardWidgetSummaryEnrichments } from "../src/lib/dashboard-widget-summary-adapter.ts";

function baseInput(overrides = {}) {
  return {
    isPreviewMode: false,
    dashboardSummary: {
      today_schedule: {
        available: true,
        expected_counts_available: true,
        rows: [{
          id: "summary-session-1",
          start_time: "17:30:00",
          end_time: "18:30:00",
          name: "Summary Fundamentals",
          capacity: 20,
          attendance_count: 7,
          expected_count: 12,
        }],
        overflow_count: 0,
      },
      emergency_contacts: {
        available: true,
        active_students: 1,
        complete_students: 1,
        missing_students: 0,
      },
    },
    isInitialDashboardLoading: false,
    datasetLoadError: null,
    hasDashboardSummary: true,
    hasPartialStudentSample: false,
    rosterSummaryPending: false,
    studentsLoaded: true,
    studentsLoadError: null,
    leadsLoaded: true,
    leadsLoadError: null,
    scheduleStatus: "ready",
    scheduleLoadError: null,
    eligibilityPending: false,
    eligibilityLoadError: null,
    today: "2026-08-17",
    students: [{
      id: "student-1",
      status: "active",
      emergency_contact_name: "Kai Parent",
      emergency_contact_phone: "555-0100",
      guardians: [],
    }],
    leads: [],
    sessions: [{
      id: "session-1",
      date: "2026-08-17",
      status: "scheduled",
      name: "Adult Fundamentals",
      start_time: "18:00:00",
      attendance_count: 8,
      capacity: 16,
    }],
    eligibility: [],
    recentStudentRows: [{ id: "student-1", displayName: "Kai Lane", status: "active", startedOn: "2026-08-01" }],
    composition: {
      displayedBillingSummary: { paymentAttentionCount: 0, hasPlans: true, paymentsReady: true },
      displayedInactivityStats: { watch14: 0, watch30: 0, watch90: 0, highestRiskStudents: [] },
      displayedLeadStats: { activeLeads: 0, enrolledLeads: 0, dueTodayLeads: 0 },
      displayedOperationalStats: {
        attendanceWithCapacity: 8,
        totalCapacity: 16,
        sessionsTracked: 1,
        sessionsWithCapacity: 1,
        utilizationRate: 0.5,
        averageAttendance: 8,
      },
      displayedStudentStats: { totalStudents: 1, activeStudents: 1, trialingStudents: 0, onHoldStudents: 0 },
      displayedTestReadinessStats: { readyToTest: 0, needsApproval: 0 },
      displayedTodaySessions: 1,
      setupSteps: [{ id: "program", title: "Programs", complete: true, actionLabel: "Open", href: "/settings" }],
    },
    ...overrides,
  };
}

describe("dashboard widget view models", () => {
  it("represents ready and preview truth without relabeling fixture data as live", () => {
    const live = buildDashboardWidgetViewModels(baseInput());
    assert.equal(live.student_pulse.state, "ready");
    assert.equal(live.student_pulse.metric, "1");
    assert.equal(live.student_pulse.provenance, "live");
    assert.deepEqual(live.student_pulse.visual, {
      kind: "ratio",
      value: 1,
      max: 1,
      label: "active students",
    });
    assert.equal(live.attendance.visual.value, 8);
    assert.equal(live.attendance.visual.max, 16);
    assert.equal(live.classes_today.rows[0].label, "Summary Fundamentals");
    assert.match(live.classes_today.rows[0].meta, /12 expected/);

    const preview = buildDashboardWidgetViewModels(baseInput({ isPreviewMode: true }));
    assert.equal(preview.student_pulse.provenance, "preview");
    assert.equal(preview.student_pulse.provenanceLabel, "Preview fixture");
  });

  it("represents loading, error, and empty states", () => {
    const loading = buildDashboardWidgetViewModels(baseInput({ isInitialDashboardLoading: true }));
    assert.ok(Object.values(loading).every((model) => model.state === "loading"));

    const error = buildDashboardWidgetViewModels(baseInput({
      datasetLoadError: "Roster failed",
      studentsLoadError: "Roster failed",
    }));
    assert.equal(error.needs_attention.state, "partial");
    assert.equal(error.student_pulse.state, "error");
    assert.equal(error.recent_students.state, "error");

    const empty = buildDashboardWidgetViewModels(baseInput({
      students: [],
      sessions: [],
      recentStudentRows: [],
      dashboardSummary: {
        today_schedule: {
          available: true,
          expected_counts_available: true,
          rows: [],
          overflow_count: 0,
        },
        emergency_contacts: {
          available: true,
          active_students: 0,
          complete_students: 0,
          missing_students: 0,
        },
      },
      composition: {
        ...baseInput().composition,
        displayedStudentStats: { totalStudents: 0, activeStudents: 0, trialingStudents: 0, onHoldStudents: 0 },
        displayedTodaySessions: 0,
        displayedOperationalStats: {
          attendanceWithCapacity: 0,
          totalCapacity: 0,
          sessionsTracked: 0,
          sessionsWithCapacity: 0,
          utilizationRate: null,
          averageAttendance: 0,
        },
      },
    }));
    assert.equal(empty.student_pulse.state, "empty");
    assert.equal(empty.classes_today.state, "empty");
    assert.equal(empty.attendance.state, "empty");
    assert.equal(empty.needs_attention.state, "empty");
  });

  it("suppresses unsafe exact facts for a partial roster and marks unsupported facts unavailable", () => {
    const partial = buildDashboardWidgetViewModels(baseInput({
      hasDashboardSummary: false,
      dashboardSummary: null,
      hasPartialStudentSample: true,
      rosterSummaryPending: true,
      students: [{ id: "sample", status: "active", guardians: [] }],
      composition: {
        ...baseInput().composition,
        displayedStudentStats: { totalStudents: 1, activeStudents: 1, trialingStudents: 0, onHoldStudents: 0 },
      },
    }));
    assert.equal(partial.student_pulse.state, "partial");
    assert.equal(partial.student_pulse.metric, "—");
    assert.equal(partial.student_pulse.visual, undefined);
    assert.equal(partial.recent_students.state, "partial");
    assert.deepEqual(partial.recent_students.rows, []);
    assert.equal(partial.emergency_contacts.state, "unavailable");
    assert.equal(partial.emergency_contacts.metric, "—");
    assert.equal(partial.revenue_due.state, "unavailable");
    assert.equal(partial.revenue_due.metric, "—");
  });

  it("marks absent billing summary facts unavailable instead of inventing amounts", () => {
    const models = buildDashboardWidgetViewModels(baseInput({
      composition: {
        ...baseInput().composition,
        displayedBillingSummary: { paymentAttentionCount: null, hasPlans: null, paymentsReady: null },
      },
    }));
    assert.equal(models.billing_exceptions.state, "unavailable");
    assert.equal(models.billing_exceptions.metric, "—");
    assert.match(models.revenue_due.detail, /not present/i);
  });

  it("prefers bounded backend schedule and exact emergency-contact enrichments", () => {
    const models = buildDashboardWidgetViewModels(baseInput({
      students: [{ id: "local-capped", status: "active", guardians: [] }],
      sessions: [{
        id: "local-session",
        date: "2026-08-17",
        status: "scheduled",
        name: "Local session must not win",
        start_time: "09:00:00",
        attendance_count: 99,
        capacity: 100,
      }],
      dashboardSummary: {
        today_schedule: {
          available: true,
          expected_counts_available: false,
          rows: [{
            id: "server-session",
            start_time: "18:00:00",
            end_time: "19:00:00",
            name: "Server-owned class",
            attendance_count: 4,
            expected_count: 11,
          }],
          overflow_count: 2,
        },
        emergency_contacts: {
          available: true,
          active_students: 17,
          complete_students: 13,
          missing_students: 4,
        },
      },
    }));
    assert.equal(models.classes_today.metric, "3");
    assert.equal(models.classes_today.rows[0].label, "Server-owned class");
    assert.match(models.classes_today.rows[0].meta, /4 checked in/);
    assert.doesNotMatch(models.classes_today.rows[0].meta, /11 expected/);
    assert.equal(models.emergency_contacts.metric, "4");
    assert.equal(models.emergency_contacts.state, "ready");
  });

  it("fails legacy or inconsistent live enrichments closed without local exact fallback", () => {
    const legacy = buildDashboardWidgetViewModels(baseInput({ dashboardSummary: {} }));
    assert.equal(legacy.classes_today.state, "unavailable");
    assert.deepEqual(legacy.classes_today.rows, []);
    assert.equal(legacy.emergency_contacts.state, "unavailable");
    assert.equal(legacy.emergency_contacts.metric, "—");

    const malformed = readDashboardWidgetSummaryEnrichments({
      emergency_contacts: {
        available: true,
        active_students: 4,
        complete_students: 3,
        missing_students: 2,
      },
    });
    assert.equal(malformed.emergencyContacts.available, false);
  });

  it("keeps preview fixtures explicitly preview-derived", () => {
    const preview = buildDashboardWidgetViewModels(baseInput({
      isPreviewMode: true,
      dashboardSummary: null,
    }));
    assert.equal(preview.classes_today.rows[0].label, "Adult Fundamentals");
    assert.equal(preview.classes_today.provenance, "preview");
    assert.equal(preview.emergency_contacts.metric, "0");
    assert.equal(preview.emergency_contacts.provenance, "preview");
  });
});
