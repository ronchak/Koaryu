"use client";

import type { ReactNode } from "react";
import {
  CheckCircle2,
  Clock3,
  CreditCard,
  Download,
  FileText,
  ListChecks,
  Loader2,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import {
  OverviewPanel,
  OverviewPanelHeader,
  SegmentedTabs,
  SetupStepList,
  type SegmentedTab,
  type SetupStep,
} from "@/components/ui/overview";
import { SectionHeader } from "./billing-page-sections";

export type BillingTab = "overview" | "plans" | "families" | "enrollments" | "invoices" | "reports";
export type BillingSetupStep = SetupStep;

const BILLING_TABS: SegmentedTab<BillingTab>[] = [
  { id: "overview", label: "Setup", icon: ListChecks },
  { id: "plans", label: "Tuition Plans", icon: Receipt },
  { id: "families", label: "Families", icon: Users },
  { id: "enrollments", label: "Student Billing", icon: CreditCard },
  { id: "invoices", label: "Invoices", icon: FileText },
  { id: "reports", label: "Advanced", icon: Download },
];

export function BillingPageFrame({
  activeTab,
  children,
  completedStepCount,
  error,
  isLiveRestricted,
  isLoading,
  isRefreshDisabled,
  message,
  onChangeTab,
  onDismissError,
  onDismissMessage,
  onRefresh,
  setupSteps,
  showLoading,
}: {
  activeTab: BillingTab;
  children: ReactNode;
  completedStepCount: number;
  error: string;
  isLiveRestricted: boolean;
  isLoading: boolean;
  isRefreshDisabled: boolean;
  message: string;
  onChangeTab: (tab: BillingTab) => void;
  onDismissError: () => void;
  onDismissMessage: () => void;
  onRefresh: () => void;
  setupSteps: BillingSetupStep[];
  showLoading: boolean;
}) {
  return (
    <>
      <Header title="Billing" description="Koaryu Core, family payments, invoices, and revenue reporting.">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshDisabled}
          isLoading={isLoading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
          {isLoading ? "Refreshing..." : "Refresh"}
        </Button>
      </Header>

      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-[1240px] space-y-5">
          {isLiveRestricted ? (
            <BillingAccessLimitedNotice />
          ) : (
            <>
              <BillingSetupNavigation
                activeTab={activeTab}
                completedStepCount={completedStepCount}
                onChangeTab={onChangeTab}
                steps={setupSteps}
              />

              <BillingFeedbackNotices
                error={error}
                message={message}
                onDismissError={onDismissError}
                onDismissMessage={onDismissMessage}
                showLoading={showLoading}
              />

              {children}

              <BillingPolicyNote />
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function BillingAccessLimitedNotice() {
  return (
    <section className="border border-border bg-surface rounded-[6px] p-6">
      <SectionHeader
        icon={ShieldCheck}
        title="Billing access is limited"
        description="Admins and front desk staff can manage studio billing. Instructors can keep using training workflows without billing access."
      />
    </section>
  );
}

export function BillingSetupNavigation({
  activeTab,
  completedStepCount,
  onChangeTab,
  steps,
}: {
  activeTab: BillingTab;
  completedStepCount: number;
  onChangeTab: (tab: BillingTab) => void;
  steps: BillingSetupStep[];
}) {
  return (
    <>
      <OverviewPanel>
        <OverviewPanelHeader
          eyebrow={`${completedStepCount} / ${steps.length} complete`}
          title="Tuition setup path"
          description="Move left to right: set up payments, create tuition plans, add families, attach students, then collect or send invoices."
        />
        <SetupStepList steps={steps} />
      </OverviewPanel>

      <SegmentedTabs
        tabs={BILLING_TABS}
        activeTab={activeTab}
        onChange={onChangeTab}
        ariaLabel="Billing sections"
      />
    </>
  );
}

export function BillingFeedbackNotices({
  error,
  message,
  onDismissError,
  onDismissMessage,
  showLoading,
}: {
  error: string;
  message: string;
  onDismissError: () => void;
  onDismissMessage: () => void;
  showLoading: boolean;
}) {
  return (
    <>
      {message ? (
        <DismissibleNotice
          tone="success"
          onDismiss={onDismissMessage}
          className="text-xs"
        >
          {message}
        </DismissibleNotice>
      ) : null}
      {error ? (
        <DismissibleNotice
          tone="danger"
          onDismiss={onDismissError}
          className="text-xs"
        >
          {error}
        </DismissibleNotice>
      ) : null}

      {showLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading billing...
        </div>
      ) : null}
    </>
  );
}

export function BillingPolicyNote() {
  return (
    <section className="border border-border bg-surface rounded-[6px] p-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <CheckCircle2 className="h-4 w-4 text-success" />
        <span>No student-count pricing. No staff-count pricing. No feature gates.</span>
        <Clock3 className="h-4 w-4 text-warning" />
        <span>Soft student alert at 1,500 active students, with no database lockout.</span>
      </div>
    </section>
  );
}
