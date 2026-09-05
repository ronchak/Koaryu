"use client";

import { useCallback, useEffect, useMemo } from "react";
import { canViewDashboardBilling } from "@/lib/dashboard-billing-summary";
import {
  buildDashboardPageComposition,
  formatDashboardTodayLabel,
} from "@/lib/dashboard-page-composition";
import {
  buildDashboardBeltStats,
  buildDashboardChurnStats,
  buildDashboardInactivityStats,
  buildDashboardLeadStats,
  buildDashboardNewStudentStats,
  buildDashboardOperationalStats,
  buildDashboardRecentStudentRows,
  buildDashboardStudentStats,
  buildDashboardTestReadinessStats,
  countDashboardTodaySessions,
} from "@/lib/dashboard-page-model";
import { subtractDays } from "@/lib/dashboard-page-utils";
import { toLocalDateKey } from "@/lib/date";
import { markPerformance } from "@/lib/performance";
import {
  dashboardSummaryDataset,
  eligibilityDataset,
  loadedDataset,
  resolvePageDatasetReadiness,
} from "@/lib/page-dataset-readiness";
import { buildStudentInactivityRows } from "@/lib/student-insights";
import { buildDashboardWidgetViewModels } from "@/lib/dashboard-widget-view-models";
import { type DashboardWidgetId, normalizeDashboardWidgetRole } from "@/lib/dashboard-widget-catalog";
import type {
  BeltsStoreContextValue,
  ConfigStoreContextValue,
  DashboardStoreContextValue,
  LeadsStoreContextValue,
  ProgramsStoreContextValue,
  ScheduleStoreContextValue,
  StudentsStoreContextValue,
  StudioStoreContextValue,
} from "@/lib/store-contexts";

type DashboardPageControllerOptions = {
  beltStore: Pick<
    BeltsStoreContextValue,
    | "beltLadders"
    | "beltLaddersLoadError"
    | "beltRanks"
    | "currentLadderId"
    | "loadEligibilityForLadder"
    | "eligibility"
    | "eligibilityLadderId"
    | "eligibilityLoadError"
    | "eligibilityPendingLadderId"
  >;
  config: Pick<ConfigStoreContextValue, "currentRole" | "isPreviewMode">;
  dashboardStore: Pick<DashboardStoreContextValue, "dashboardSummary" | "dashboardSummaryLoaded">;
  leadStore: Pick<
    LeadsStoreContextValue,
    "leads" | "leadsLoaded" | "leadsLoadError" | "refreshLeads"
  >;
  programsStore: Pick<
    ProgramsStoreContextValue,
    "programs" | "programsLoaded" | "programsLoadError" | "refreshPrograms"
  >;
  scheduleStore: Pick<
    ScheduleStoreContextValue,
    "attendance" | "refreshSchedule" | "scheduleLoadError" | "scheduleStatus" | "sessions" | "templates"
  >;
  studentsStore: Pick<
    StudentsStoreContextValue,
    "refreshStudents" | "students" | "studentsLoaded" | "studentsLoadError" | "studentsMayBePartial"
  >;
  studioStore: Pick<
    StudioStoreContextValue,
    "identityGeneration" | "currentStudioId" | "currentUserId" | "studioName" | "userName"
  >;
};

export function useDashboardPageController({
  beltStore,
  config,
  dashboardStore,
  leadStore,
  programsStore,
  scheduleStore,
  studentsStore,
  studioStore,
}: DashboardPageControllerOptions) {
  const {
    beltRanks,
    beltLaddersLoadError,
    currentLadderId,
    loadEligibilityForLadder,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError: eligibilityReadError,
    eligibilityPendingLadderId,
  } = beltStore;
  const eligibilityLoadError = beltLaddersLoadError || eligibilityReadError;
  const { currentRole, isPreviewMode } = config;
  const { dashboardSummary, dashboardSummaryLoaded } = dashboardStore;
  const { leads, leadsLoaded, leadsLoadError, refreshLeads } = leadStore;
  const { programs, programsLoaded, programsLoadError, refreshPrograms } = programsStore;
  const {
    attendance,
    refreshSchedule,
    scheduleLoadError,
    scheduleStatus,
    sessions,
    templates,
  } = scheduleStore;
  const {
    refreshStudents,
    students,
    studentsLoaded,
    studentsLoadError,
    studentsMayBePartial,
  } = studentsStore;
  const { identityGeneration, currentStudioId, currentUserId, studioName, userName } = studioStore;

  const summary = isPreviewMode ? null : dashboardSummary;
  const hasDashboardSummary = Boolean(summary);
  const normalizedRole = normalizeDashboardWidgetRole(currentRole);
  const isDashboardIdentityReady = Boolean(
    currentUserId.trim()
    && currentStudioId?.trim()
    && normalizedRole
  );
  const summaryReadiness = dashboardSummaryDataset({
    hasSummary: hasDashboardSummary,
    isPreviewMode,
    loaded: dashboardSummaryLoaded,
  });
  const beltEligibilityReadiness = eligibilityDataset({
    currentLadderId,
    error: eligibilityLoadError,
    loadedLadderId: eligibilityLadderId,
    pendingLadderId: eligibilityPendingLadderId,
  });
  const setupReadiness = resolvePageDatasetReadiness([
    loadedDataset({ error: beltLaddersLoadError, label: "Belt plans", loaded: !beltLaddersLoadError }),
    loadedDataset({ error: studentsLoadError, label: "Student roster", loaded: studentsLoaded }),
    loadedDataset({ error: programsLoadError, label: "Programs", loaded: programsLoaded }),
    loadedDataset({ error: leadsLoadError, label: "Leads", loaded: leadsLoaded }),
    {
      error: scheduleLoadError,
      label: "Schedule",
      status: scheduleStatus,
    },
    summaryReadiness,
  ]);
  const datasetReadiness = resolvePageDatasetReadiness([
    { label: "Dashboard data", ...setupReadiness }, beltEligibilityReadiness,
  ]);
  const onVisibleWidgetsChange = useCallback((ids: DashboardWidgetId[]) => {
    if (!ids.includes("promotions_due") || !currentLadderId
      || eligibilityLadderId === currentLadderId || eligibilityPendingLadderId
      || eligibilityLoadError) return;
    void loadEligibilityForLadder(currentLadderId).catch(() => undefined);
  }, [currentLadderId, eligibilityLadderId, eligibilityPendingLadderId,
    eligibilityLoadError, loadEligibilityForLadder]);
  const isInitialDashboardLoading = !isDashboardIdentityReady;
  const hasPartialStudentSample = !isPreviewMode && studentsMayBePartial;
  const rosterSummaryPending = hasPartialStudentSample && !summary;
  const shouldShowLocalStudentDetails = !hasPartialStudentSample;
  const today = toLocalDateKey();
  const displayedToday = summary?.today ?? today;
  const todayLabel = useMemo(
    () => formatDashboardTodayLabel(displayedToday),
    [displayedToday]
  );
  const canSeeBilling = canViewDashboardBilling({ currentRole, summary });
  const studentCount = students.length;
  const sessionCount = sessions.length;
  const templateCount = templates.length;

  useEffect(() => {
    if (!summary) {
      return;
    }

    markPerformance("dashboard.summary_rendered", { source: "bootstrap" });
  }, [summary]);

  const retryDashboardDatasets = useCallback(() => {
    if (
      (!isPreviewMode && dashboardSummaryLoaded && !dashboardSummary)
      || eligibilityLoadError
    ) {
      window.location.reload();
      return;
    }

    void Promise.allSettled([
      refreshStudents(),
      refreshPrograms({ includeArchived: true }),
      refreshLeads(),
      refreshSchedule(),
    ]);
  }, [
    dashboardSummary,
    dashboardSummaryLoaded,
    eligibilityLoadError,
    isPreviewMode,
    refreshLeads,
    refreshPrograms,
    refreshSchedule,
    refreshStudents,
  ]);

  const lookback14 = useMemo(() => subtractDays(today, 14), [today]);
  const lookback30 = useMemo(() => subtractDays(today, 30), [today]);
  const lookback90 = useMemo(() => subtractDays(today, 90), [today]);
  const yearStart = useMemo(() => `${today.slice(0, 4)}-01-01`, [today]);

  const studentStats = useMemo(() => buildDashboardStudentStats(students, today), [students, today]);
  const leadStats = useMemo(() => buildDashboardLeadStats(leads, today), [leads, today]);
  const todaySessions = useMemo(() => countDashboardTodaySessions(sessions, today), [sessions, today]);
  const beltStats = useMemo(() => buildDashboardBeltStats(beltRanks), [beltRanks]);
  const inactivityRows = useMemo(
    () => buildStudentInactivityRows(students, sessions, attendance, today),
    [attendance, sessions, students, today]
  );
  const inactivityStats = useMemo(() => buildDashboardInactivityStats(inactivityRows), [inactivityRows]);
  const newStudentStats = useMemo(
    () => buildDashboardNewStudentStats(students, today, lookback14, lookback30, lookback90, yearStart),
    [lookback14, lookback30, lookback90, students, today, yearStart]
  );
  const operationalStats = useMemo(
    () => buildDashboardOperationalStats(attendance, sessions, lookback30, today),
    [attendance, lookback30, sessions, today]
  );
  const churnStats = useMemo(() => buildDashboardChurnStats(students), [students]);
  const testReadinessStats = useMemo(() => buildDashboardTestReadinessStats(eligibility), [eligibility]);

  const dashboardComposition = useMemo(
    () => buildDashboardPageComposition({
      canSeeBilling,
      isPreviewMode,
      localStats: {
        studentStats,
        leadStats,
        todaySessions,
        beltStats,
        inactivityStats,
        newStudentStats,
        operationalStats,
        churnStats,
        testReadinessStats,
      },
      ownerName: userName || null,
      ownerSeedKey: currentUserId || userName || null,
      programs,
      rosterSummaryPending,
      sessionCount,
      shouldShowLocalStudentDetails,
      studentCount,
      summary,
      templateCount,
      todayDateKey: displayedToday,
      todayLabel,
    }),
    [
      beltStats,
      canSeeBilling,
      churnStats,
      currentUserId,
      displayedToday,
      inactivityStats,
      isPreviewMode,
      leadStats,
      newStudentStats,
      operationalStats,
      programs,
      rosterSummaryPending,
      sessionCount,
      shouldShowLocalStudentDetails,
      studentCount,
      studentStats,
      summary,
      templateCount,
      testReadinessStats,
      todayLabel,
      todaySessions,
      userName,
    ]
  );

  const recentStudentRows = useMemo(
    () => buildDashboardRecentStudentRows(summary?.recent_students, students, hasPartialStudentSample),
    [hasPartialStudentSample, students, summary?.recent_students]
  );
  const widgetViewModels = useMemo(() => buildDashboardWidgetViewModels({
    isPreviewMode,
    dashboardSummary: summary,
    dashboardSummaryLoaded,
    datasetLoadError: setupReadiness.error,
    allDatasetEvidenceReady: setupReadiness.status === "ready",
    canSeeBilling,
    canSeeLeads: normalizedRole === "admin" || normalizedRole === "front_desk",
    hasDashboardSummary,
    hasPartialStudentSample,
    studentsLoaded,
    studentsLoadError,
    leadsLoaded,
    leadsLoadError,
    scheduleStatus,
    scheduleLoadError,
    eligibilityReady: beltEligibilityReadiness.status === "ready",
    eligibilityLoadError,
    today,
    students,
    leads,
    sessions,
    eligibility,
    recentStudentRows,
    composition: dashboardComposition,
  }), [
    dashboardComposition,
    summary,
    dashboardSummaryLoaded,
    setupReadiness.error,
    setupReadiness.status,
    eligibility,
    eligibilityLoadError,
    hasDashboardSummary,
    hasPartialStudentSample,
    isPreviewMode,
    leads,
    leadsLoadError,
    leadsLoaded,
    recentStudentRows,
    scheduleLoadError,
    scheduleStatus,
    sessions,
    students,
    studentsLoadError,
    studentsLoaded,
    today,
    canSeeBilling,
    normalizedRole,
    beltEligibilityReadiness.status,
  ]);

  const studioDescription = studioName || (
    isInitialDashboardLoading ? "Loading studio..." : "Your studio at a glance."
  );

  return {
    contentProps: {
      canSeeBilling,
      currentRole,
      identityGeneration,
      onVisibleWidgetsChange,
      currentStudioId,
      currentUserId,
      dashboardComposition,
      datasetLoadError: datasetReadiness.error,
      isDashboardDataReady: datasetReadiness.status === "ready",
      hasDashboardSummary,
      hasPartialStudentSample,
      isDashboardIdentityReady,
      isInitialDashboardLoading,
      lookback30,
      recentStudentRows,
      retryDashboardDatasets,
      rosterSummaryPending,
      shouldShowLocalStudentDetails,
      studioDescription,
      today,
      todayLabel,
      isPreviewMode,
      widgetViewModels,
    },
  };
}

export type DashboardPageController = ReturnType<typeof useDashboardPageController>;
