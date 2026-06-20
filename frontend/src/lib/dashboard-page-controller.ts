"use client";

import { useEffect, useMemo } from "react";
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
  beltStore: Pick<BeltsStoreContextValue, "beltLadders" | "beltRanks" | "eligibility">;
  config: Pick<ConfigStoreContextValue, "currentRole" | "isPreviewMode">;
  dashboardStore: Pick<DashboardStoreContextValue, "dashboardSummary">;
  leadStore: Pick<LeadsStoreContextValue, "leads">;
  programsStore: Pick<ProgramsStoreContextValue, "programs">;
  scheduleStore: Pick<ScheduleStoreContextValue, "attendance" | "sessions" | "templates">;
  studentsStore: Pick<
    StudentsStoreContextValue,
    "students" | "studentsLoaded" | "studentsMayBePartial"
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
  const { beltLadders, beltRanks, eligibility } = beltStore;
  const { currentRole, isPreviewMode } = config;
  const { dashboardSummary } = dashboardStore;
  const { leads } = leadStore;
  const { programs } = programsStore;
  const { attendance, sessions, templates } = scheduleStore;
  const {
    students,
    studentsLoaded,
    studentsMayBePartial,
  } = studentsStore;
  const { studioName } = studioStore;

  const summary = isPreviewMode ? null : dashboardSummary;
  const hasDashboardSummary = Boolean(summary);
  const isInitialDashboardLoading = !studentsLoaded;
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
      hasDashboardSummary,
      hasPartialStudentSample,
      isInitialDashboardLoading,
      kpiBreakdowns,
      lookback30,
      programBuckets,
      programById,
      recentStudentRows,
      rosterSummaryPending,
      shouldShowLocalStudentDetails,
      studioDescription,
      today,
      todayLabel,
    },
  };
}

export type DashboardPageController = ReturnType<typeof useDashboardPageController>;
