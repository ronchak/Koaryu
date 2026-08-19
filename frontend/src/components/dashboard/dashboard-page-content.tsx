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
  isDashboardIdentityReady,
  isPreviewMode,
  retryDashboardDatasets,
  studioDescription,
  widgetViewModels,
}: DashboardPageContentProps) {
  if (!isDashboardIdentityReady) {
    return (
      <div className="flex-1 bg-[var(--product-ground)] p-6 text-[var(--product-ink)] sm:p-8" aria-busy="true">
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
      identityReady={isDashboardIdentityReady}
      isPreviewMode={isPreviewMode}
      retryDashboardDatasets={retryDashboardDatasets}
      studioDescription={studioDescription}
      viewModels={widgetViewModels}
    />
  );
}
