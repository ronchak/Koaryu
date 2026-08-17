"use client";

import { DashboardHome } from "@/components/dashboard/dashboard-home";
import { DashboardLoadingPanel } from "@/components/dashboard/dashboard-overview-sections";
import type { DashboardPageController } from "@/lib/dashboard-page-controller";

type DashboardPageContentProps = DashboardPageController["contentProps"];

export function DashboardPageContent({
  currentRole,
  currentStudioId,
  currentUserId,
  datasetLoadError,
  isInitialDashboardLoading,
  isPreviewMode,
  retryDashboardDatasets,
  studioDescription,
  widgetViewModels,
}: DashboardPageContentProps) {
  if (isInitialDashboardLoading) {
    return (
      <div className="flex-1 bg-[#fbf8f0] p-6 text-[#302719] sm:p-8" aria-busy="true">
        <div className="max-w-6xl">
          <DashboardLoadingPanel />
        </div>
      </div>
    );
  }

  return (
    <DashboardHome
      key={`${currentUserId}:${currentStudioId ?? "no-studio"}:${currentRole ?? "unknown"}`}
      currentRole={currentRole}
      currentStudioId={currentStudioId}
      currentUserId={currentUserId}
      datasetLoadError={datasetLoadError}
      isPreviewMode={isPreviewMode}
      retryDashboardDatasets={retryDashboardDatasets}
      studioDescription={studioDescription}
      viewModels={widgetViewModels}
    />
  );
}
