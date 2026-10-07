"use client";

import { useResumeRefresh } from "@/lib/use-resume-refresh";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canViewDashboardBilling } from "@/lib/dashboard-billing-summary";
import { buildDashboardPageComposition } from "@/lib/dashboard-page-composition";
import {
  buildDashboardBeltStats,
  buildDashboardInactivityStats,
  buildDashboardLeadStats,
  buildDashboardOperationalStats,
  buildDashboardRecentStudentRows,
  buildDashboardStudentStats,
  buildDashboardTestReadinessStats,
  countDashboardTodaySessions,
} from "@/lib/dashboard-page-model";
import { subtractDays } from "@/lib/dashboard-page-utils";
import { markPerformance } from "@/lib/performance";
import {
  dashboardSummaryDataset,
  eligibilityDataset,
  loadedDataset,
  resolvePageDatasetReadiness,
} from "@/lib/page-dataset-readiness";
import { buildStudentInactivityRows } from "@/lib/student-insights";
import { buildDashboardWidgetViewModels } from "@/lib/dashboard-widget-view-models";
import {
  type DashboardWidgetId,
  normalizeDashboardWidgetRole,
} from "@/lib/dashboard-widget-catalog";
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
    | "refreshDashboardPromotions"
    | "dashboardPromotionsLoading"
    | "eligibility"
    | "eligibilityLadderId"
    | "eligibilityLoadError"
    | "eligibilityPendingLadderId"
  >;
  config: Pick<ConfigStoreContextValue, "businessDate" | "currentRole" | "isPreviewMode">;
  dashboardStore: Pick<
    DashboardStoreContextValue,
    | "dashboardSummary"
    | "dashboardSummaryLoaded"
    | "dashboardSummaryLoadError"
    | "refreshDashboardSummary"
  >;
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
    | "attendance"
    | "refreshSchedule"
    | "scheduleLoadError"
    | "scheduleStatus"
    | "sessions"
    | "templates"
  >;
  studentsStore: Pick<
    StudentsStoreContextValue,
    "refreshStudents" | "students" | "studentsLoaded" | "studentsLoadError" | "studentsMayBePartial"
  >;
  studioStore: Pick<
    StudioStoreContextValue,
    "identityGeneration" | "currentStudioId" | "currentUserId" | "studioName"
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
    refreshDashboardPromotions,
    dashboardPromotionsLoading,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError: eligibilityReadError,
    eligibilityPendingLadderId,
  } = beltStore;
  const eligibilityLoadError = beltLaddersLoadError || eligibilityReadError;
  const { currentRole, isPreviewMode } = config;
  const {
    dashboardSummary,
    dashboardSummaryLoaded,
    dashboardSummaryLoadError,
    refreshDashboardSummary,
  } = dashboardStore;
  const { leads, leadsLoaded, leadsLoadError, refreshLeads } = leadStore;
  const { programs, programsLoaded, programsLoadError, refreshPrograms } = programsStore;
  const { attendance, refreshSchedule, scheduleLoadError, scheduleStatus, sessions, templates } =
    scheduleStore;
  const { refreshStudents, students, studentsLoaded, studentsLoadError, studentsMayBePartial } =
    studentsStore;
  const { identityGeneration, currentStudioId, currentUserId, studioName } = studioStore;
  const today = config.businessDate;
  const visibilityScope = `${identityGeneration}:${currentUserId}:${currentStudioId}:${currentRole}:${today}`;
  const visibleWidgetsRef = useRef<{ scope: string; ids: DashboardWidgetId[] }>({
    scope: "",
    ids: [],
  });
  const [promotionVisibility, setPromotionVisibility] = useState({ scope: "", visible: false });
  const promotionsVisible =
    promotionVisibility.scope === visibilityScope && promotionVisibility.visible;
  const [visibleWidgetIds, setVisibleWidgetIds] = useState<DashboardWidgetId[]>([]);

  const summary = isPreviewMode ? null : dashboardSummary;
  const hasDashboardSummary = Boolean(summary);
  const normalizedRole = normalizeDashboardWidgetRole(currentRole);
  const isDashboardIdentityReady = Boolean(
    currentUserId.trim() && currentStudioId?.trim() && normalizedRole,
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
    loadedDataset({
      error: beltLaddersLoadError,
      label: "Belt plans",
      loaded: !beltLaddersLoadError,
    }),
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
    { label: "Dashboard data", ...setupReadiness },
    beltEligibilityReadiness,
  ]);
  const onVisibleWidgetsChange = useCallback(
    (ids: DashboardWidgetId[]) => {
      const previous = visibleWidgetsRef.current;
      const visible = ids.includes("promotions_due");
      visibleWidgetsRef.current = { scope: visibilityScope, ids };
      setVisibleWidgetIds((current) =>
        current.length === ids.length && current.every((id, index) => id === ids[index])
          ? current
          : ids,
      );
      setPromotionVisibility((current) =>
        current.scope === visibilityScope && current.visible === visible
          ? current
          : { scope: visibilityScope, visible },
      );
      if (
        !isPreviewMode &&
        visible &&
        (previous.scope !== visibilityScope || !previous.ids.includes("promotions_due"))
      ) {
        void refreshDashboardPromotions().catch(() => undefined);
      }
    },
    [isPreviewMode, refreshDashboardPromotions, visibilityScope],
  );
  const isInitialDashboardLoading = !isDashboardIdentityReady;
  const hasPartialStudentSample = !isPreviewMode && studentsMayBePartial;
  const rosterSummaryPending = hasPartialStudentSample && !summary;
  const shouldShowLocalStudentDetails = !hasPartialStudentSample;
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
    if (isPreviewMode) {
      void Promise.allSettled([
        loadEligibilityForLadder(currentLadderId, { force: true }),
        refreshStudents(),
        refreshPrograms({ includeArchived: true }),
        refreshLeads(),
        refreshSchedule(),
      ]);
      return;
    }
    void Promise.allSettled([
      refreshDashboardSummary(),
      ...(visibleWidgetsRef.current.scope === visibilityScope &&
      visibleWidgetsRef.current.ids.includes("promotions_due")
        ? [refreshDashboardPromotions()]
        : []),
    ]);
  }, [
    currentLadderId,
    loadEligibilityForLadder,
    refreshDashboardSummary,
    refreshLeads,
    refreshPrograms,
    refreshSchedule,
    refreshStudents,
    isPreviewMode,
    refreshDashboardPromotions,
    visibilityScope,
  ]);
  useResumeRefresh(() => {
    if (isPreviewMode) return;
    return Promise.allSettled([
      refreshDashboardSummary({ reason: "resume" }),
      ...(visibleWidgetsRef.current.scope === visibilityScope &&
      visibleWidgetsRef.current.ids.includes("promotions_due")
        ? [refreshDashboardPromotions()]
        : []),
    ]);
  });

  useEffect(() => {
    if (!isPreviewMode && isDashboardIdentityReady) {
      void refreshDashboardSummary({ reason: "visit" }).catch(() => undefined);
    }
  }, [isDashboardIdentityReady, isPreviewMode, refreshDashboardSummary, today]);

  const lookback30 = useMemo(() => subtractDays(today, 30), [today]);

  const studentStats = useMemo(
    () => buildDashboardStudentStats(students, today),
    [students, today],
  );
  const leadStats = useMemo(() => buildDashboardLeadStats(leads, today), [leads, today]);
  const todaySessions = useMemo(
    () => countDashboardTodaySessions(sessions, today),
    [sessions, today],
  );
  const beltStats = useMemo(() => buildDashboardBeltStats(beltRanks), [beltRanks]);
  const inactivityRows = useMemo(
    () => buildStudentInactivityRows(students, sessions, attendance, today),
    [attendance, sessions, students, today],
  );
  const inactivityStats = useMemo(
    () => buildDashboardInactivityStats(inactivityRows),
    [inactivityRows],
  );
  const operationalStats = useMemo(
    () => buildDashboardOperationalStats(attendance, sessions, lookback30, today),
    [attendance, lookback30, sessions, today],
  );
  const testReadinessStats = useMemo(
    () => buildDashboardTestReadinessStats(eligibility),
    [eligibility],
  );

  const dashboardComposition = useMemo(
    () =>
      buildDashboardPageComposition({
        canSeeBilling,
        isPreviewMode,
        localStats: {
          studentStats,
          leadStats,
          todaySessions,
          beltStats,
          inactivityStats,
          operationalStats,
          testReadinessStats,
        },
        programs,
        rosterSummaryPending,
        sessionCount,
        shouldShowLocalStudentDetails,
        studentCount,
        summary,
        templateCount,
      }),
    [
      beltStats,
      canSeeBilling,
      inactivityStats,
      isPreviewMode,
      leadStats,
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
      todaySessions,
    ],
  );

  const recentStudentRows = useMemo(
    () =>
      buildDashboardRecentStudentRows(summary?.recent_students, students, hasPartialStudentSample),
    [hasPartialStudentSample, students, summary?.recent_students],
  );
  const widgetViewModels = useMemo(
    () =>
      buildDashboardWidgetViewModels({
        isPreviewMode,
        dashboardSummary: summary,
        dashboardSummaryLoaded,
        datasetLoadError: isPreviewMode ? setupReadiness.error : summaryReadiness.error,
        allDatasetEvidenceReady: isPreviewMode
          ? setupReadiness.status === "ready"
          : summaryReadiness.status === "ready",
        canSeeBilling,
        canSeeLeads: normalizedRole === "admin" || normalizedRole === "front_desk",
        role: normalizedRole,
        hasDashboardSummary,
        hasPartialStudentSample,
        studentsLoaded,
        studentsLoadError,
        leadsLoaded,
        leadsLoadError,
        scheduleStatus,
        scheduleLoadError,
        eligibilityReady:
          (!dashboardPromotionsLoading && beltEligibilityReadiness.status === "ready") ||
          Boolean(currentLadderId && eligibilityLadderId === currentLadderId),
        eligibilityLoadError,
        today,
        students,
        leads,
        sessions,
        eligibility,
        recentStudentRows,
        composition: dashboardComposition,
      }),
    [
      dashboardComposition,
      summary,
      dashboardSummaryLoaded,
      setupReadiness.error,
      setupReadiness.status,
      summaryReadiness.error,
      summaryReadiness.status,
      currentLadderId,
      eligibilityLadderId,
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
      dashboardPromotionsLoading,
    ],
  );

  const studioDescription =
    studioName || (isInitialDashboardLoading ? "Loading studio..." : "Your studio at a glance.");

  return {
    contentProps: {
      canSeeBilling,
      currentRole,
      identityGeneration,
      onVisibleWidgetsChange,
      currentStudioId,
      currentUserId,
      datasetLoadError: isPreviewMode
        ? datasetReadiness.error
        : dashboardSummaryLoadError ||
          (promotionsVisible ? eligibilityLoadError : null) ||
          (visibleWidgetIds.includes("lead_follow_ups") &&
          widgetViewModels.lead_follow_ups.state === "unavailable"
            ? "Lead follow-ups could not be loaded. Retry dashboard data to check again."
            : null),
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
      isPreviewMode,
      widgetViewModels,
    },
  };
}

export type DashboardPageController = ReturnType<typeof useDashboardPageController>;
