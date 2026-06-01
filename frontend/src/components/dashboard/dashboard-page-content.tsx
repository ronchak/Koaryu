"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import {
  DashboardActivityPanels,
  DashboardLoadingPanel,
  DashboardOwnerBriefPanel,
  DashboardOwnerMetricGrid,
  DashboardProgramBucketsPanel,
  DashboardRecentStudentsPanel,
  DashboardStudentMovementSections,
} from "@/components/dashboard/dashboard-overview-sections";
import { DashboardOperationalKpisPanel } from "@/components/dashboard/dashboard-operational-kpis-panel";
import type { KpiInsight } from "@/components/dashboard/dashboard-page-sections";
import { KpiInsightModalLoading } from "@/components/dashboard/dashboard-page-sections";
import { Header } from "@/components/header";
import type { DashboardPageController } from "@/lib/dashboard-page-controller";

const KpiInsightModal = dynamic(
  () => import("@/components/dashboard/kpi-insight-modal").then((mod) => mod.KpiInsightModal),
  {
    loading: () => <KpiInsightModalLoading />,
    ssr: false,
  }
);

type DashboardPageContentProps = DashboardPageController["contentProps"];

export function DashboardPageContent({
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
}: DashboardPageContentProps) {
  const [activeKpiInsight, setActiveKpiInsight] = useState<KpiInsight | null>(null);
  const {
    displayedStudentStats,
    displayedLeadStats,
    displayedTodaySessions,
    displayedInactivityStats,
    displayedOperationalStats,
    displayedChurnStats,
    displayedTestReadinessStats,
    displayedBillingSummary,
    inactiveSegments,
    newStudentSegments,
    ownerBrief,
    setupSteps,
    todayActions,
  } = dashboardComposition;

  return (
    <>
      <Header
        title="Dashboard"
        description={studioDescription}
      />
      <div className="flex-1 p-6 sm:p-8">
        <div className="max-w-6xl">
          {isInitialDashboardLoading ? (
            <DashboardLoadingPanel />
          ) : (
            <>
              <DashboardOwnerBriefPanel
                ownerBrief={ownerBrief}
                todayLabel={todayLabel}
                todayActions={todayActions}
                setupSteps={setupSteps}
              />

              <DashboardOwnerMetricGrid
                studentStats={displayedStudentStats}
                leadStats={displayedLeadStats}
                testReadinessStats={displayedTestReadinessStats}
                billingSummary={displayedBillingSummary}
                todaySessions={displayedTodaySessions}
                canSeeBilling={canSeeBilling}
                hasDashboardSummary={hasDashboardSummary}
                hasPartialStudentSample={hasPartialStudentSample}
              />

              <DashboardStudentMovementSections
                inactiveSegments={inactiveSegments}
                newStudentSegments={newStudentSegments}
                hasDashboardSummary={hasDashboardSummary}
                rosterSummaryPending={rosterSummaryPending}
                hasPartialStudentSample={hasPartialStudentSample}
              />

              <DashboardActivityPanels
                inactivityStats={displayedInactivityStats}
                hasPartialStudentSample={hasPartialStudentSample}
                rosterSummaryPending={rosterSummaryPending}
              />

              <DashboardOperationalKpisPanel
                operationalStats={displayedOperationalStats}
                testReadinessStats={displayedTestReadinessStats}
                churnStats={displayedChurnStats}
                studentStats={displayedStudentStats}
                kpiBreakdowns={kpiBreakdowns}
                lookback30={lookback30}
                today={today}
                rosterSummaryPending={rosterSummaryPending}
                shouldShowLocalStudentDetails={shouldShowLocalStudentDetails}
                onOpenInsight={setActiveKpiInsight}
              />

              <DashboardProgramBucketsPanel
                programBuckets={programBuckets}
                programById={programById}
                hasPartialStudentSample={hasPartialStudentSample}
              />

              <DashboardRecentStudentsPanel
                recentStudentRows={recentStudentRows}
                hasDashboardSummary={hasDashboardSummary}
                hasPartialStudentSample={hasPartialStudentSample}
              />
            </>
          )}
        </div>
      </div>
      {activeKpiInsight ? (
        <KpiInsightModal
          key={activeKpiInsight.id}
          insight={activeKpiInsight}
          onClose={() => setActiveKpiInsight(null)}
        />
      ) : null}
    </>
  );
}
