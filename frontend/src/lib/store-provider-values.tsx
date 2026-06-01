"use client";

import { useMemo, type ReactNode } from "react";

import {
  BeltsStoreContext,
  ConfigStoreContext,
  DashboardStoreContext,
  LeadsStoreContext,
  ProgramsStoreContext,
  ScheduleStoreContext,
  StudioStoreContext,
  StudentsStoreContext,
  type BeltsStoreContextValue,
  type ConfigStoreContextValue,
  type DashboardStoreContextValue,
  type LeadsStoreContextValue,
  type ProgramsStoreContextValue,
  type ScheduleStoreContextValue,
  type StoreContextValue,
  type StudentsStoreContextValue,
  type StudioStoreContextValue,
} from "@/lib/store-contexts";
import {
  toPromotionHistoryByStudent,
  type PromotionHistoryCache,
} from "@/lib/store-promotion-history";

type StoreContextValueInputs = Omit<StoreContextValue, "promotionHistoryByStudent"> & {
  promotionHistoryCache: PromotionHistoryCache;
};

export type StoreContextProviderValues = {
  beltsValue: BeltsStoreContextValue;
  configValue: ConfigStoreContextValue;
  dashboardValue: DashboardStoreContextValue;
  leadsValue: LeadsStoreContextValue;
  programsValue: ProgramsStoreContextValue;
  scheduleValue: ScheduleStoreContextValue;
  studentsValue: StudentsStoreContextValue;
  studioValue: StudioStoreContextValue;
};

export function useStoreContextValues(input: StoreContextValueInputs): StoreContextProviderValues {
  const {
    addLead,
    addSession,
    addStudent,
    addTemplate,
    archiveProgram,
    attendance,
    beltLadders,
    beltRanks,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
    clearStudioData,
    clearSubscriptionRequired,
    convertLeadToStudent,
    createProgram,
    currentLadderId,
    currentRole,
    currentUserId,
    dashboardSummary,
    dashboardSummaryLoaded,
    deleteLead,
    deleteSession,
    deleteStudentPhoto,
    deleteStudents,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError,
    eligibilityPendingLadderId,
    importStudents,
    inviteStaff,
    isPreviewMode,
    ladderName,
    leads,
    listStudentsPage,
    loadPromotionHistory,
    markSubscriptionRequired,
    programs,
    programsLoaded,
    programsLoadError,
    promoteStudent,
    promotionHistoryCache,
    refreshLeads,
    refreshPrograms,
    refreshScheduleRange,
    refreshSessionAttendance,
    refreshStaff,
    refreshStudents,
    removeStaff,
    resetDemoData,
    restoreProgram,
    sessions,
    setBeltRanks,
    setCurrentLadder,
    setLadderName,
    setStudioName,
    setSubRankTerm,
    staffLoadError,
    staffLoaded,
    staffMembers,
    students,
    studentsLastLoadedAt,
    studentsLoadError,
    studentsLoaded,
    studentsMayBePartial,
    studioName,
    subRankTerm,
    subscriptionRequired,
    templates,
    toggleCheckIn,
    token,
    updateLead,
    updateProgram,
    updateStaffRole,
    updateStudent,
    updateUserName,
    uploadStudentPhoto,
    userEmail,
    userName,
  } = input;

  const configValue = useMemo<ConfigStoreContextValue>(() => ({
    isPreviewMode,
    token,
    subscriptionRequired,
    markSubscriptionRequired,
    clearSubscriptionRequired,
    currentRole,
  }), [clearSubscriptionRequired, currentRole, isPreviewMode, markSubscriptionRequired, subscriptionRequired, token]);

  const dashboardValue = useMemo<DashboardStoreContextValue>(() => ({
    dashboardSummary,
    dashboardSummaryLoaded,
  }), [dashboardSummary, dashboardSummaryLoaded]);

  const studentsValue = useMemo<StudentsStoreContextValue>(() => ({
    studentsLoaded,
    studentsLoadError,
    studentsLastLoadedAt,
    studentsMayBePartial,
    students,
    addStudent,
    updateStudent,
    deleteStudents,
    uploadStudentPhoto,
    deleteStudentPhoto,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
    importStudents,
    listStudentsPage,
    refreshStudents,
  }), [
    studentsLoaded,
    studentsLoadError,
    studentsLastLoadedAt,
    studentsMayBePartial,
    addStudent,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
    deleteStudentPhoto,
    deleteStudents,
    importStudents,
    listStudentsPage,
    refreshStudents,
    students,
    updateStudent,
    uploadStudentPhoto,
  ]);

  const leadsValue = useMemo<LeadsStoreContextValue>(() => ({
    leads,
    addLead,
    updateLead,
    deleteLead,
    refreshLeads,
    convertLeadToStudent,
  }), [
    addLead,
    convertLeadToStudent,
    deleteLead,
    leads,
    refreshLeads,
    updateLead,
  ]);

  const programsValue = useMemo<ProgramsStoreContextValue>(() => ({
    programs,
    programsLoaded,
    programsLoadError,
    refreshPrograms,
    createProgram,
    updateProgram,
    archiveProgram,
    restoreProgram,
  }), [
    archiveProgram,
    createProgram,
    programs,
    programsLoaded,
    programsLoadError,
    refreshPrograms,
    restoreProgram,
    updateProgram,
  ]);

  const promotionHistoryByStudent = useMemo(
    () => toPromotionHistoryByStudent(promotionHistoryCache),
    [promotionHistoryCache]
  );

  const beltsValue = useMemo<BeltsStoreContextValue>(() => ({
    beltLadders,
    beltRanks,
    currentLadderId,
    setCurrentLadder,
    setBeltRanks,
    ladderName,
    setLadderName,
    subRankTerm,
    setSubRankTerm,
    eligibility,
    eligibilityLadderId,
    eligibilityPendingLadderId,
    eligibilityLoadError,
    promotionHistoryByStudent,
    loadPromotionHistory,
    promoteStudent,
  }), [
    beltLadders,
    beltRanks,
    currentLadderId,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError,
    eligibilityPendingLadderId,
    ladderName,
    loadPromotionHistory,
    promotionHistoryByStudent,
    setCurrentLadder,
    promoteStudent,
    setBeltRanks,
    setLadderName,
    setSubRankTerm,
    subRankTerm,
  ]);

  const scheduleValue = useMemo<ScheduleStoreContextValue>(() => ({
    sessions,
    addSession,
    addTemplate,
    deleteSession,
    refreshScheduleRange,
    refreshSessionAttendance,
    templates,
    attendance,
    toggleCheckIn,
  }), [
    addSession,
    addTemplate,
    attendance,
    deleteSession,
    refreshScheduleRange,
    refreshSessionAttendance,
    sessions,
    templates,
    toggleCheckIn,
  ]);

  const studioValue = useMemo<StudioStoreContextValue>(() => ({
    studioName,
    currentUserId,
    currentRole,
    userEmail,
    userName,
    staffMembers,
    staffLoaded,
    staffLoadError,
    refreshStaff,
    inviteStaff,
    updateStaffRole,
    removeStaff,
    resetDemoData,
    clearStudioData,
    setStudioName,
    updateUserName,
  }), [
    clearStudioData,
    currentRole,
    currentUserId,
    inviteStaff,
    refreshStaff,
    removeStaff,
    resetDemoData,
    setStudioName,
    staffLoadError,
    staffLoaded,
    staffMembers,
    studioName,
    updateUserName,
    updateStaffRole,
    userEmail,
    userName,
  ]);

  return {
    beltsValue,
    configValue,
    dashboardValue,
    leadsValue,
    programsValue,
    scheduleValue,
    studentsValue,
    studioValue,
  };
}

export function StoreContextProviders({
  children,
  values,
}: {
  children: ReactNode;
  values: StoreContextProviderValues;
}) {
  return (
    <ConfigStoreContext.Provider value={values.configValue}>
      <DashboardStoreContext.Provider value={values.dashboardValue}>
        <StudentsStoreContext.Provider value={values.studentsValue}>
          <ProgramsStoreContext.Provider value={values.programsValue}>
            <LeadsStoreContext.Provider value={values.leadsValue}>
              <BeltsStoreContext.Provider value={values.beltsValue}>
                <ScheduleStoreContext.Provider value={values.scheduleValue}>
                  <StudioStoreContext.Provider value={values.studioValue}>
                    {children}
                  </StudioStoreContext.Provider>
                </ScheduleStoreContext.Provider>
              </BeltsStoreContext.Provider>
            </LeadsStoreContext.Provider>
          </ProgramsStoreContext.Provider>
        </StudentsStoreContext.Provider>
      </DashboardStoreContext.Provider>
    </ConfigStoreContext.Provider>
  );
}
