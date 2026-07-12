"use client";

import { useCallback, useEffect, useMemo } from "react";
import { buildKpiBreakdowns, buildRankFamilyIndex } from "@/lib/dashboard-kpi-breakdowns";
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
  buildDashboardProgramBuckets,
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
    | "beltRanks"
    | "currentLadderId"
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
  studioStore: Pick<StudioStoreContextValue, "studioName">;
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
    beltLadders,
    beltRanks,
    currentLadderId,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError,
    eligibilityPendingLadderId,
  } = beltStore;
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
  const { studioName } = studioStore;

  const summary = isPreviewMode ? null : dashboardSummary;
  const hasDashboardSummary = Boolean(summary);
  const datasetReadiness = resolvePageDatasetReadiness([
    loadedDataset({ error: studentsLoadError, label: "Student roster", loaded: studentsLoaded }),
    loadedDataset({ error: programsLoadError, label: "Programs", loaded: programsLoaded }),
    loadedDataset({ error: leadsLoadError, label: "Leads", loaded: leadsLoaded }),
    {
      error: scheduleLoadError,
      label: "Schedule",
      status: scheduleStatus,
    },
    dashboardSummaryDataset({
      hasSummary: hasDashboardSummary,
      isPreviewMode,
      loaded: dashboardSummaryLoaded,
    }),
    eligibilityDataset({
      currentLadderId,
      error: eligibilityLoadError,
      loadedLadderId: eligibilityLadderId,
      pendingLadderId: eligibilityPendingLadderId,
    }),
  ]);
  const isInitialDashboardLoading = datasetReadiness.status === "loading";
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
  const programById = useMemo(
    () => new Map(programs.map((program) => [program.id, program])),
    [programs]
  );
  const rankNameById = useMemo(
    () => new Map(
      (beltLadders.length > 0 ? beltLadders.flatMap((ladder) => ladder.ranks) : beltRanks)
        .map((rank) => [rank.id, rank.name])
    ),
    [beltLadders, beltRanks]
  );
  const rankFamilyById = useMemo(
    () => buildRankFamilyIndex(beltLadders, programById),
    [beltLadders, programById]
  );

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
      programs,
      rosterSummaryPending,
      sessionCount,
      shouldShowLocalStudentDetails,
      studentCount,
      summary,
      templateCount,
      todayLabel,
    }),
    [
      beltStats,
      canSeeBilling,
      churnStats,
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
    ]
  );
  const kpiBreakdowns = useMemo(() => {
    return buildKpiBreakdowns({
      attendance,
      eligibility,
      lookback30,
      programById,
      rankFamilyById,
      rankNameById,
      sessions,
      students,
      today,
    });
  }, [attendance, eligibility, lookback30, programById, rankFamilyById, rankNameById, sessions, students, today]);

  const recentStudentRows = useMemo(
    () => buildDashboardRecentStudentRows(summary?.recent_students, students, hasPartialStudentSample),
    [hasPartialStudentSample, students, summary?.recent_students]
  );
  const programBuckets = useMemo(
    () => buildDashboardProgramBuckets(programs, programById, students, leads, sessions, today),
    [leads, programById, programs, sessions, students, today]
  );
  const studioDescription = studioName || (
    isInitialDashboardLoading ? "Loading studio..." : "Your studio at a glance."
  );

  return {
    contentProps: {
      canSeeBilling,
      dashboardComposition,
      datasetLoadError: datasetReadiness.error,
      hasDashboardSummary,
      hasPartialStudentSample,
      isInitialDashboardLoading,
      kpiBreakdowns,
      lookback30,
      programBuckets,
      programById,
      recentStudentRows,
      retryDashboardDatasets,
      rosterSummaryPending,
      shouldShowLocalStudentDetails,
      studioDescription,
      today,
      todayLabel,
    },
  };
}

export type DashboardPageController = ReturnType<typeof useDashboardPageController>;
