"use client";

import { DashboardHome } from "@/components/dashboard/dashboard-home";
import type { DashboardPageController } from "@/lib/dashboard-page-controller";

type DashboardPageContentProps = DashboardPageController["contentProps"];

export function DashboardPageContent({
  currentRole,
  identityGeneration,
  onVisibleWidgetsChange,
  currentStudioId,
  currentUserId,
  datasetLoadError,
  isDashboardDataReady,
  isDashboardIdentityReady,
  isPreviewMode,
  retryDashboardDatasets,
  studioDescription,
  widgetViewModels,
}: DashboardPageContentProps) {
  return (
    <DashboardHome
      key={`${currentUserId}:${currentStudioId ?? "no-studio"}:${currentRole ?? "unknown"}`}
      currentRole={currentRole}
      identityGeneration={identityGeneration}
      onVisibleWidgetsChange={onVisibleWidgetsChange}
      currentStudioId={currentStudioId}
      currentUserId={currentUserId}
      datasetLoadError={datasetLoadError}
      dataReady={isDashboardDataReady}
      identityReady={isDashboardIdentityReady}
      isPreviewMode={isPreviewMode}
      retryDashboardDatasets={retryDashboardDatasets}
      studioDescription={studioDescription}
      viewModels={widgetViewModels}
    />
  );
}
