"use client";

import { BillingPageFrame } from "@/components/billing/billing-page-chrome";
import { BillingTabContent } from "@/components/billing/billing-tab-content";
import type { BillingPageController } from "@/lib/billing-page-controller";

type BillingPageContentProps = BillingPageController["contentProps"];

export function BillingPageContent({
  activeTab,
  billingSetupCompleteCount,
  billingSetupSteps,
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
  showBillingLoading,
  tabContentProps,
}: BillingPageContentProps) {
  return (
    <>
      {connectEntityModal}

      <BillingPageFrame
        activeTab={activeTab}
        completedStepCount={billingSetupCompleteCount}
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
        showLoading={showBillingLoading}
      >
        <BillingTabContent {...tabContentProps} />
      </BillingPageFrame>
    </>
  );
}
