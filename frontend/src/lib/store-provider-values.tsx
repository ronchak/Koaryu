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
    archiveStaff,
    archiveProgram,
    attendance,
    beltLadders,
    beltLaddersLoadError,
    beltRanks,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
    clearStudioData,
    clearSubscriptionRequired,
    convertLeadToStudent,
    createProgram,
    currentLadderId,
    currentRole,
    currentStudioId,
    currentUserId,
    dashboardSummary,
    dashboardSummaryLoaded,
    deleteLead,
    deleteSession,
    deleteStudentPhoto,
    deleteStudents,
    demoteStudent,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError,
    eligibilityPendingLadderId,
    importStudents,
    inviteStaff,
    isPreviewMode,
    legalFirstName,
    legalLastName,
    ladderName,
    leads,
    leadsLoaded,
    leadsLoadError,
    listStudentsPage,
    loadPromotionHistory,
    loadEligibilityForLadder,
    markSubscriptionRequired,
    programs,
    programsLoaded,
    programsUsageLoaded,
    programsUsageLoadError,
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
    refreshSchedule,
    scheduleLoadError,
    scheduleStatus,
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
    studioLoadError,
    subRankTerm,
    subscriptionRequired,
    staffProfilesAvailable,
    identityGeneration,
    identityReady,
    identityLoadError,
    retryInitialization,
    templates,
    toggleCheckIn,
    token,
    unarchiveStaff,
    updateLead,
    updateProgram,
    updateStaffLegalName,
    updateStaffRole,
    scheduleStaffDeletion,
    updateStudent,
    updateUserLegalName,
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
    leadsLoaded,
    leadsLoadError,
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
    leadsLoaded,
    leadsLoadError,
    refreshLeads,
    updateLead,
  ]);

  const programsValue = useMemo<ProgramsStoreContextValue>(() => ({
    programs,
    programsLoaded,
    programsUsageLoaded,
    programsUsageLoadError,
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
    programsUsageLoaded,
    programsUsageLoadError,
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
    beltLaddersLoadError,
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
    loadEligibilityForLadder,
    demoteStudent,
    promoteStudent,
  }), [
    beltLadders,
    beltLaddersLoadError,
    beltRanks,
    currentLadderId,
    demoteStudent,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError,
    eligibilityPendingLadderId,
    ladderName,
    loadPromotionHistory,
    loadEligibilityForLadder,
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
    refreshSchedule,
    scheduleLoadError,
    scheduleStatus,
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
    refreshSchedule,
    scheduleLoadError,
    scheduleStatus,
    sessions,
    templates,
    toggleCheckIn,
  ]);

  const studioValue = useMemo<StudioStoreContextValue>(() => ({
    studioName,
    studioLoadError,
    currentStudioId,
    currentUserId,
    currentRole,
    userEmail,
    userName,
    staffProfilesAvailable,
    identityGeneration,
    identityReady,
    identityLoadError,
    retryInitialization,
    legalFirstName,
    legalLastName,
    staffMembers,
    staffLoaded,
    staffLoadError,
    refreshStaff,
    inviteStaff,
    archiveStaff,
    unarchiveStaff,
    scheduleStaffDeletion,
    updateStaffRole,
    updateStaffLegalName,
    removeStaff,
    resetDemoData,
    clearStudioData,
    setStudioName,
    updateUserLegalName,
    updateUserName,
  }), [
    clearStudioData,
    currentRole,
    currentStudioId,
    currentUserId,
    archiveStaff,
    inviteStaff,
    refreshStaff,
    removeStaff,
    scheduleStaffDeletion,
    resetDemoData,
    setStudioName,
    staffLoadError,
    staffLoaded,
    staffMembers,
    studioName,
    studioLoadError,
    updateUserLegalName,
    updateUserName,
    updateStaffRole,
    unarchiveStaff,
    updateStaffLegalName,
    userEmail,
    userName,
    staffProfilesAvailable,
    identityGeneration,
    identityReady,
    identityLoadError,
    retryInitialization,
    legalFirstName,
    legalLastName,
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
