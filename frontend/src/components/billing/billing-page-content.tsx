"use client";

import { BillingPageFrame } from "@/components/billing/billing-page-chrome";
import { BillingTabContent } from "@/components/billing/billing-tab-content";
import type { BillingPageController } from "@/lib/billing-page-controller";

type BillingPageContentProps = BillingPageController["contentProps"];

export function BillingPageContent({
  activeTab,
  hasMoreHistory,
  isLoadingMore,
  loadMoreHistory,  billingSetupCompleteCount,
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
        {["invoices", "reports"].includes(activeTab) && (tabContentProps.billingPayments.length > 0 || (activeTab === "invoices" && tabContentProps.billingInvoices.length > 0)) && (
          <div className="mt-4 flex items-center justify-between gap-4 text-sm text-muted">
            <span>{hasMoreHistory ? "Showing recent history. Older records are available." : "All records from the last successful history read are shown."}</span>
            {hasMoreHistory && <button type="button" className="rounded-lg border border-border px-4 py-2 text-ink" disabled={isLoadingMore} onClick={() => void loadMoreHistory()}>{isLoadingMore ? "Loading older history…" : "Load older history"}</button>}
          </div>
        )}
      </BillingPageFrame>
    </>
  );
}
