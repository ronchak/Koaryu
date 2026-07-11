import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildStudentQueryFilterState,
  buildStudentRosterLoadState,
  buildStudentRows,
  filterStudentRows,
  formatDate,
  getNewStudentStartDate,
  parseBulkTagsInput,
  shouldUseDerivedRosterFilters,
  withStudentRosterRefreshWarning,
} from "../src/lib/students-page-model.ts";

function program(id, name) {
  return {
    id,
    studio_id: "studio-1",
    name,
    color_hex: "#1E90FF",
    sort_order: 0,
    is_system: false,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    usage: { active_student_count: 0, active_schedule_template_count: 0 },
  };
}

function membership(programId, overrides = {}) {
  return {
    id: `${programId}-membership`,
    studio_id: "studio-1",
    student_id: "student-1",
    program_id: programId,
    program_name: programId,
    status: "active",
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function student(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    legal_first_name: "Ava",
    legal_last_name: "Lane",
    preferred_name: "",
    is_minor: false,
    email: "",
    phone: "",
    status: "active",
    membership_start_date: "2026-05-20",
    program_id: "kids",
    program_memberships: [],
    tags: [],
    guardians: [],
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

const FILTER_DEFAULTS = {
  search: "",
  statusFilter: "",
  programFilter: "",
  inactivityThreshold: null,
  inactivityByStudentId: new Map(),
  newStudentStartDate: null,
  today: "2026-05-24",
  sortKey: "name",
  sortDir: "asc",
  usesDerivedRosterFilters: true,
};

describe("students page model", () => {
  it("builds roster rows with display, active program, contact, and tag fields", () => {
    const rows = buildStudentRows(
      [
        student("student-1", {
          legal_first_name: "Ari",
          legal_last_name: "Stone",
          preferred_name: "Ace",
          is_minor: true,
          guardians: [{ id: "g-1", first_name: "Gina", last_name: "Stone", email: "guardian@example.test", is_primary_contact: true }],
          tags: ["paid", "vip", "trial"],
          program_memberships: [
            membership("kids", { program_name: "Kids BJJ" }),
            membership("adults", { program_name: "Adults", status: "ended", ended_at: "2026-05-01" }),
          ],
        }),
      ],
      [program("kids", "Kids BJJ"), program("adults", "Adults")]
    );

    assert.equal(rows[0].displayName, "Stone, Ace");
    assert.deepEqual(rows[0].programs.map((item) => item.id), ["kids"]);
    assert.equal(rows[0].contact, "guardian@example.test");
    assert.deepEqual(rows[0].visibleTags, ["paid", "vip"]);
    assert.equal(rows[0].hiddenTagCount, 1);
    assert.match(rows[0].searchFields.programs, /adults/);
  });

  it("applies local roster filters only for derived roster views", () => {
    const rows = buildStudentRows(
      [
        student("ava", {
          legal_first_name: "Ava",
          legal_last_name: "Zimmer",
          status: "active",
          membership_start_date: "2026-05-20",
          program_id: "kids",
          program_memberships: [membership("kids", { program_name: "Kids BJJ" })],
        }),
        student("bo", {
          legal_first_name: "Bo",
          legal_last_name: "Brown",
          status: "paused",
          membership_start_date: "2026-05-10",
          program_id: "adults",
          program_memberships: [membership("adults", { program_name: "Adults" })],
        }),
        student("cyd", {
          legal_first_name: "Cyd",
          legal_last_name: "Current",
          status: "inactive",
          membership_start_date: "2026-05-22",
          program_id: "kids",
          program_memberships: [membership("kids", { program_name: "Kids BJJ" })],
        }),
      ],
      [program("kids", "Kids BJJ"), program("adults", "Adults")]
    );

    const filtered = filterStudentRows(rows, {
      ...FILTER_DEFAULTS,
      search: "kids",
      programFilter: "kids",
      inactivityThreshold: 7,
      inactivityByStudentId: new Map([
        ["ava", 8],
        ["bo", 20],
        ["cyd", 10],
      ]),
      newStudentStartDate: "2026-05-18",
    });

    assert.deepEqual(filtered.map((row) => row.student.id), ["ava"]);
  });

  it("preserves server-provided paging order when derived roster filters are disabled", () => {
    const rows = buildStudentRows(
      [
        student("bo", { legal_first_name: "Bo", legal_last_name: "Brown", status: "paused" }),
        student("ava", { legal_first_name: "Ava", legal_last_name: "Aardvark", status: "active" }),
      ],
      []
    );

    const filtered = filterStudentRows(rows, {
      ...FILTER_DEFAULTS,
      search: "missing",
      statusFilter: "active",
      sortDir: "desc",
      usesDerivedRosterFilters: false,
    });

    assert.deepEqual(filtered.map((row) => row.student.id), ["bo", "ava"]);
  });

  it("derives new-student date windows without route-local date math", () => {
    assert.equal(
      getNewStudentStartDate({ today: "2026-05-24", isNewStudentYtd: true, newStudentDays: null }),
      "2026-01-01"
    );
    assert.equal(
      getNewStudentStartDate({ today: "2026-05-24", isNewStudentYtd: false, newStudentDays: 14 }),
      "2026-05-10"
    );
    assert.equal(
      getNewStudentStartDate({ today: "2026-05-24", isNewStudentYtd: false, newStudentDays: null }),
      null
    );
    assert.equal(formatDate(), "\u2014");
  });

  it("centralizes query-driven roster filter state", () => {
    assert.deepEqual(
      buildStudentQueryFilterState({
        fullRosterParam: "1",
        inactiveDaysParam: "30",
        newStudentsParam: "ytd",
        today: "2026-05-24",
      }),
      {
        fullRosterRequested: true,
        hasNewStudentFilter: true,
        inactivityThreshold: 30,
        isNewStudentYtd: true,
        newStudentDays: null,
        newStudentStartDate: "2026-01-01",
      }
    );

    assert.deepEqual(
      buildStudentQueryFilterState({
        fullRosterParam: null,
        inactiveDaysParam: "",
        newStudentsParam: "14",
        today: "2026-05-24",
      }),
      {
        fullRosterRequested: false,
        hasNewStudentFilter: true,
        inactivityThreshold: null,
        isNewStudentYtd: false,
        newStudentDays: 14,
        newStudentStartDate: "2026-05-10",
      }
    );
  });

  it("chooses derived roster mode only when client-side filters require full data", () => {
    assert.equal(
      shouldUseDerivedRosterFilters({
        fullRosterRequested: false,
        hasNewStudentFilter: false,
        inactivityThreshold: null,
        pagedRosterEnabled: true,
      }),
      false
    );
    assert.equal(
      shouldUseDerivedRosterFilters({
        fullRosterRequested: true,
        hasNewStudentFilter: false,
        inactivityThreshold: null,
        pagedRosterEnabled: true,
      }),
      true
    );
    assert.equal(
      shouldUseDerivedRosterFilters({
        fullRosterRequested: false,
        hasNewStudentFilter: false,
        inactivityThreshold: null,
        pagedRosterEnabled: false,
      }),
      true
    );
  });

  it("builds roster loading, pagination, and refreshing state", () => {
    assert.deepEqual(
      buildStudentRosterLoadState({
        programsLoadError: null,
        programsLoaded: true,
        scheduleLoadError: null,
        scheduleRequired: false,
        scheduleStatus: "idle",
        isDerivedRosterRefreshing: true,
        isPagedLoading: false,
        page: 1,
        pageSize: 50,
        pagedLoadError: null,
        pagedLoaded: false,
        pagedTotal: 0,
        studentsCount: 12,
        studentsLoadError: null,
        studentsLoaded: true,
        studentsMayBePartial: false,
        usesDerivedRosterFilters: true,
      }),
      {
        activeLoadError: null,
        isInitialRosterLoading: true,
        isRosterRefreshing: false,
        pageEnd: 0,
        pageStart: 0,
        totalPages: 1,
        visibleTotal: 12,
      }
    );

    assert.deepEqual(
      buildStudentRosterLoadState({
        programsLoadError: null,
        programsLoaded: true,
        scheduleLoadError: null,
        scheduleRequired: false,
        scheduleStatus: "idle",
        isDerivedRosterRefreshing: false,
        isPagedLoading: true,
        page: 3,
        pageSize: 50,
        pagedLoadError: "Paged error",
        pagedLoaded: true,
        pagedTotal: 121,
        studentsCount: 12,
        studentsLoadError: null,
        studentsLoaded: true,
        studentsMayBePartial: false,
        usesDerivedRosterFilters: false,
      }),
      {
        activeLoadError: "Paged error",
        isInitialRosterLoading: false,
        isRosterRefreshing: true,
        pageEnd: 121,
        pageStart: 101,
        totalPages: 3,
        visibleTotal: 121,
      }
    );
  });

  it("depends on programs but not schedule for the default roster", () => {
    const base = {
      programsLoadError: null,
      programsLoaded: true,
      scheduleLoadError: "Schedule is unavailable",
      scheduleRequired: false,
      scheduleStatus: "error",
      isDerivedRosterRefreshing: false,
      isPagedLoading: false,
      page: 1,
      pageSize: 50,
      pagedLoadError: null,
      pagedLoaded: true,
      pagedTotal: 2,
      studentsCount: 2,
      studentsLoadError: null,
      studentsLoaded: true,
      studentsMayBePartial: false,
      usesDerivedRosterFilters: false,
    };

    assert.equal(buildStudentRosterLoadState(base).isInitialRosterLoading, false);
    assert.equal(buildStudentRosterLoadState(base).activeLoadError, null);
    assert.equal(
      buildStudentRosterLoadState({ ...base, programsLoaded: false }).isInitialRosterLoading,
      true
    );
  });

  it("requires a successful schedule only when an inactivity filter consumes it", () => {
    const state = buildStudentRosterLoadState({
      programsLoadError: null,
      programsLoaded: true,
      scheduleLoadError: "Schedule timed out",
      scheduleRequired: true,
      scheduleStatus: "error",
      isDerivedRosterRefreshing: false,
      isPagedLoading: false,
      page: 1,
      pageSize: 50,
      pagedLoadError: null,
      pagedLoaded: true,
      pagedTotal: 2,
      studentsCount: 2,
      studentsLoadError: null,
      studentsLoaded: true,
      studentsMayBePartial: false,
      usesDerivedRosterFilters: true,
    });

    assert.equal(state.isInitialRosterLoading, false);
    assert.equal(state.activeLoadError, "Schedule timed out");
  });

  it("parses comma-separated bulk tags with trimming and de-duping", () => {
    assert.deepEqual(parseBulkTagsInput(" vip, leadership, vip, , needs follow-up "), [
      "vip",
      "leadership",
      "needs follow-up",
    ]);
  });

  it("appends the roster refresh warning without losing the primary success message", () => {
    assert.equal(
      withStudentRosterRefreshWarning("Student added to the roster."),
      "Student added to the roster. Koaryu could not refresh the visible roster automatically; refresh the page if the list looks stale."
    );
    assert.equal(
      withStudentRosterRefreshWarning(null),
      "Koaryu could not refresh the visible roster automatically; refresh the page if the list looks stale."
    );
  });
});
