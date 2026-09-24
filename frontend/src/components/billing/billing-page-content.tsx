"use client";

import { BillingPageFrame } from "@/components/billing/billing-page-chrome";
import { BillingTabContent } from "@/components/billing/billing-tab-content";
import type { BillingPageController } from "@/lib/billing-page-controller";

type BillingPageContentProps = BillingPageController["contentProps"];

export function BillingPageContent({
  activeTab,
  hasMoreHistory,
  isLoadingMore,
  loadMoreHistory,
  billingSetupCompleteCount,
  billingSetupSteps,
  billingProviderCopy,
  connectEntityModal,
  error,
  isLiveRestricted,
  isLoading,
  isRefreshDisabled,
  message,
  onChangeTab,
  onDismissError,
  onDismissMessage,
  onRefresh,
  showBillingContent,
  showBillingLoading,
  tabContentProps,
}: BillingPageContentProps) {
  const enrollmentCount = tabContentProps.billingEnrollments.length;
  // A paged list always says whether more records exist, so it is never read as complete.
  const showPagedFooter =
    activeTab === "enrollments"
      ? enrollmentCount > 0
      : ["invoices", "reports"].includes(activeTab) &&
        (tabContentProps.billingPayments.length > 0 ||
          (activeTab === "invoices" && tabContentProps.billingInvoices.length > 0));
  const pagedCopy =
    activeTab === "enrollments"
      ? {
          more: `Showing ${enrollmentCount} billing enrollments. More enrollments exist.`,
          all: `All ${enrollmentCount} billing enrollments from the last successful read are shown.`,
          load: "Load more enrollments",
          loading: "Loading more enrollments…",
        }
      : {
          more: "Showing recent history. Older records are available.",
          all: "All records from the last successful history read are shown.",
          load: "Load older history",
          loading: "Loading older history…",
        };
  return (
    <>
      {connectEntityModal}

      <BillingPageFrame
        activeTab={activeTab}
        completedStepCount={billingSetupCompleteCount}
        billingBoundaryMessage={billingProviderCopy.boundary}
        error={error}
        isLiveRestricted={isLiveRestricted}
        isLoading={isLoading}
        isRefreshDisabled={isRefreshDisabled}
        message={message}
        onChangeTab={onChangeTab}
        onDismissError={onDismissError}
        onDismissMessage={onDismissMessage}
        onRefresh={onRefresh}
        setupSteps={billingSetupSteps}
        showContent={showBillingContent}
        showLoading={showBillingLoading}
      >
        <BillingTabContent {...tabContentProps} />
        {showPagedFooter && (
          <div className="mt-4 flex items-center justify-between gap-4 text-sm text-muted">
            <span>{hasMoreHistory ? pagedCopy.more : pagedCopy.all}</span>
            {hasMoreHistory && (
              <button
                type="button"
                className="rounded-lg border border-border px-4 py-2 text-ink"
                disabled={isLoadingMore}
                onClick={() => void loadMoreHistory()}
              >
                {isLoadingMore ? pagedCopy.loading : pagedCopy.load}
              </button>
            )}
          </div>
        )}
      </BillingPageFrame>
    </>
  );
}
