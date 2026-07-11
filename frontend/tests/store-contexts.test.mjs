import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BeltsStoreContext,
  ConfigStoreContext,
  DashboardStoreContext,
  LeadsStoreContext,
  ProgramsStoreContext,
  ScheduleStoreContext,
  StudentsStoreContext,
  StudioStoreContext,
  useConfigStore,
  useStore,
  useStudentStore,
} from "../src/lib/store-contexts.ts";

const noop = async () => undefined;

function renderWithStoreContexts(child) {
  const config = {
    isPreviewMode: true,
    token: "token_1",
    subscriptionRequired: false,
    markSubscriptionRequired: () => {},
    clearSubscriptionRequired: () => {},
    currentRole: "admin",
  };
  const dashboard = {
    dashboardSummary: null,
    dashboardSummaryLoaded: true,
  };
  const students = {
    studentsLoaded: true,
    studentsLoadError: null,
    studentsLastLoadedAt: 123,
    studentsMayBePartial: false,
    students: [{ id: "student_1", legal_first_name: "Ari", legal_last_name: "Lane" }],
    addStudent: async () => students.students[0],
    updateStudent: noop,
    deleteStudents: noop,
    uploadStudentPhoto: async () => students.students[0],
    deleteStudentPhoto: async () => students.students[0],
    bulkAddTagsToStudents: async () => ({ updated: 1 }),
    bulkUpdateStudentStatus: async () => ({ updated: 1 }),
    importStudents: async () => ({ imported_count: 0, errors: [], warnings: [] }),
    refreshStudents: async () => students.students,
    listStudentsPage: async () => ({ items: students.students, total: 1, page: 1, page_size: 50 }),
  };
  const programs = {
    programs: [],
    programsLoaded: true,
    programsLoadError: null,
    refreshPrograms: async () => [],
    createProgram: async () => ({}),
    updateProgram: async () => ({}),
    archiveProgram: async () => ({}),
    restoreProgram: async () => ({}),
  };
  const leads = {
    leads: [{ id: "lead_1" }],
    leadsLoaded: true,
    leadsLoadError: null,
    addLead: noop,
    updateLead: noop,
    deleteLead: noop,
    refreshLeads: async () => leads.leads,
    convertLeadToStudent: async () => ({ lead: leads.leads[0], studentId: "student_1" }),
  };
  const belts = {
    beltLadders: [],
    beltRanks: [],
    currentLadderId: null,
    setCurrentLadder: noop,
    setBeltRanks: noop,
    ladderName: "",
    setLadderName: () => {},
    subRankTerm: "Stripe",
    setSubRankTerm: noop,
    eligibility: [],
    eligibilityLadderId: null,
    eligibilityPendingLadderId: null,
    eligibilityLoadError: null,
    promotionHistoryByStudent: {},
    loadPromotionHistory: async () => [],
    promoteStudent: async () => ({}),
  };
  const schedule = {
    sessions: [],
    scheduleLoadError: null,
    scheduleStatus: "ready",
    addSession: noop,
    addTemplate: async () => ({}),
    deleteSession: noop,
    refreshScheduleRange: async () => [],
    refreshSessionAttendance: async () => ({ committed: true, records: [] }),
    refreshSchedule: noop,
    templates: [],
    attendance: [],
    toggleCheckIn: noop,
  };
  const studio = {
    studioName: "North Dojo",
    currentUserId: "user_1",
    currentRole: "admin",
    userEmail: "owner@example.test",
    userName: "Owner",
    staffMembers: [],
    staffLoaded: true,
    staffLoadError: null,
    setStudioName: noop,
    updateUserName: noop,
    refreshStaff: async () => [],
    inviteStaff: async () => ({}),
    updateStaffRole: async () => ({}),
    removeStaff: noop,
    resetDemoData: async () => ({}),
    clearStudioData: async () => ({}),
  };

  return renderToStaticMarkup(
    React.createElement(ConfigStoreContext.Provider, { value: config },
      React.createElement(DashboardStoreContext.Provider, { value: dashboard },
        React.createElement(StudentsStoreContext.Provider, { value: students },
          React.createElement(ProgramsStoreContext.Provider, { value: programs },
            React.createElement(LeadsStoreContext.Provider, { value: leads },
              React.createElement(BeltsStoreContext.Provider, { value: belts },
                React.createElement(ScheduleStoreContext.Provider, { value: schedule },
                  React.createElement(StudioStoreContext.Provider, { value: studio }, child)
                )
              )
            )
          )
        )
      )
    )
  );
}

describe("store context contracts", () => {
  it("composes split store contexts through the public hooks", () => {
    function Probe() {
      const config = useConfigStore();
      const store = useStore();

      return React.createElement(
        "output",
        null,
        `${config.token}:${store.studioName}:${store.students.length}:${store.leads.length}:${store.currentRole}`
      );
    }

    assert.equal(
      renderWithStoreContexts(React.createElement(Probe)),
      "<output>token_1:North Dojo:1:1:admin</output>"
    );
  });

  it("keeps missing provider failures explicit", () => {
    function MissingProviderProbe() {
      useStudentStore();
      return React.createElement("output", null, "unreachable");
    }

    assert.throws(
      () => renderToStaticMarkup(React.createElement(MissingProviderProbe)),
      /useStudentStore must be used within StoreProvider/
    );
  });
});
