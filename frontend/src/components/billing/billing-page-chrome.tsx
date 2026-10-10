"use client";

import type { ReactNode } from "react";
import {
  CheckCircle2,
  Clock3,
  CreditCard,
  Download,
  FileText,
  ListChecks,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { BillingContentPlaceholder } from "./billing-page-loading";
import { resolveBillingProviderCopy } from "@/lib/billing-policy";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { SetupStepList, type SetupStep } from "@/components/ui/overview";
import { SectionHeader } from "./billing-page-sections";
import { BILLING_TABS, type BillingTab } from "@/lib/billing-page-state";

export type { BillingTab } from "@/lib/billing-page-state";
export type BillingSetupStep = SetupStep;

const BILLING_TAB_PRESENTATION = {
  overview: { label: "Setup", icon: ListChecks },
  plans: { label: "Tuition Plans", icon: Receipt },
  families: { label: "Families", icon: Users },
  enrollments: { label: "Student Billing", icon: CreditCard },
  invoices: { label: "Invoices", icon: FileText },
  reports: { label: "Advanced", icon: Download },
} as const;

export function BillingPageFrame({
  activeTab,
  billingBoundaryMessage,
  children,
  completedStepCount,
  setupReady,
  canRefundPayments,
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
  showContent,
  showLoading,
}: {
  activeTab: BillingTab;
  billingBoundaryMessage: string;
  children: ReactNode;
  completedStepCount: number;
  setupReady: boolean;
  canRefundPayments?: boolean;
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
  showContent: boolean;
  showLoading: boolean;
}) {
  return (
    <OperationsSurface page="billing">
      <Header title="Billing">
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

      <div
        className="flex-1 p-4 sm:p-6"
        data-billing-ledger="six-views"
        aria-busy={isLoading || showLoading}
      >
        <div className="mx-auto max-w-[1240px] space-y-5">
          {isLiveRestricted ? (
            <BillingAccessLimitedNotice />
          ) : (
            <>
              <BillingSetupNavigation
                activeTab={activeTab}
                completedStepCount={completedStepCount}
                ready={setupReady}
                onChangeTab={onChangeTab}
                steps={setupSteps}
              />

              <BillingFeedbackNotices
                error={error}
                message={message}
                onDismissError={onDismissError}
                onDismissMessage={onDismissMessage}
              />

              <section className="rounded-[14px] bg-warning/5 p-4 text-xs text-text-secondary">
                {billingBoundaryMessage}
              </section>

              {showLoading ? (
                <BillingContentPlaceholder
                  activeTab={activeTab}
                  canRefundPayments={canRefundPayments}
                />
              ) : showContent ? (
                children
              ) : null}

              <BillingPolicyNote />
            </>
          )}
        </div>
      </div>
    </OperationsSurface>
  );
}

export function BillingAccessLimitedNotice() {
  return (
    <section className="rounded-[14px] bg-surface p-4">
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
  ready = true,
  onChangeTab,
  steps,
}: {
  activeTab: BillingTab;
  completedStepCount: number;
  ready?: boolean;
  onChangeTab: (tab: BillingTab) => void;
  steps: BillingSetupStep[];
}) {
  return (
    <>
      <section className="overflow-hidden bg-surface" data-billing-setup-register="true">
        <div className="grid border-b border-border px-4 py-4 sm:grid-cols-[minmax(12rem,0.35fr)_1fr] sm:gap-8 sm:px-5">
          <div>
            <p className="text-xs font-medium text-muted">
              {ready ? `${completedStepCount} of ${steps.length} ready` : "Review status pending"}
            </p>
            <h2 className="mt-1 text-base font-semibold text-text-primary">Billing review</h2>
          </div>
          <p className="text-xs leading-5 text-text-secondary">
            Review provider state, plans, and families before posting external payments or
            reconciling open invoices.
          </p>
        </div>
        <SetupStepList steps={steps} />
      </section>

      <nav
        className="rounded-[14px] bg-surface p-2 shadow-[var(--product-shadow-card)]"
        aria-label="Billing views"
        data-billing-book-index="six-views"
        data-print-hide="true"
      >
        <ol className="grid list-none grid-cols-2 gap-1 p-0 sm:grid-cols-3 xl:grid-cols-6">
          {BILLING_TABS.map((tab) => {
            const { icon: Icon, label } = BILLING_TAB_PRESENTATION[tab];
            const isActive = activeTab === tab;
            return (
              <li key={tab}>
                <button
                  type="button"
                  onClick={() => onChangeTab(tab)}
                  aria-pressed={isActive}
                  className={`grid min-h-14 w-full grid-cols-[1fr_auto] items-center gap-x-2 rounded-[10px] px-3 py-2 text-left ${isActive ? "bg-accent/10 text-text-primary" : "text-text-secondary hover:bg-surface-raised"}`}
                >
                  <strong className="text-xs font-semibold">{label}</strong>
                  <Icon aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}

export function BillingFeedbackNotices({
  error,
  message,
  onDismissError,
  onDismissMessage,
}: {
  error: string;
  message: string;
  onDismissError: () => void;
  onDismissMessage: () => void;
}) {
  return (
    <>
      {message ? (
        <DismissibleNotice tone="success" onDismiss={onDismissMessage} className="text-xs">
          {message}
        </DismissibleNotice>
      ) : null}
      {error ? (
        <DismissibleNotice tone="danger" onDismiss={onDismissError} className="text-xs">
          {error}
        </DismissibleNotice>
      ) : null}
    </>
  );
}

export function BillingPolicyNote() {
  return (
    <section className="rounded-[14px] bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <CheckCircle2 className="h-4 w-4 text-success" />
        <span>No student-count pricing. No staff-count pricing. No feature gates.</span>
        <Clock3 className="h-4 w-4 text-warning" />
        <span>Soft student alert at 1,500 active students, with no database lockout.</span>
      </div>
    </section>
  );
}

const pendingSetupSteps: BillingSetupStep[] = [
  {
    id: "payments",
    title: "Review payment status",
    description: "Review the studio's Stripe status.",
    complete: false,
    actionLabel: "Review setup",
  },
  {
    id: "plans",
    title: "Review tuition plans",
    description:
      "Review the studio's existing tuition plans. Plan changes are currently unavailable.",
    complete: false,
    actionLabel: "Review plans",
  },
  {
    id: "families",
    title: "Review families",
    description: "Review existing payer accounts for parents, guardians, or adult students.",
    complete: false,
    actionLabel: "Review families",
  },
  {
    id: "student-billing",
    title: "Attach students",
    description:
      "Connect active students to the right family, tuition plan, collection mode, and billing dates.",
    complete: false,
    actionLabel: "Attach student",
  },
  {
    id: "collect",
    title: "Review invoices and payments",
    description: "Record payer-level external payments and reconcile existing provider invoices.",
    complete: false,
    actionLabel: "Review invoices",
  },
];
const noop = () => {};

export function BillingPageFallback({ activeTab = "overview" }: { activeTab?: BillingTab }) {
  const copy = resolveBillingProviderCopy({
    isPreviewMode: false,
    providerMode: undefined,
    coreSubscription: false,
    connectOnboarding: false,
    connectPayments: false,
  });
  return (
    <BillingPageFrame
      activeTab={activeTab}
      billingBoundaryMessage={copy.boundary}
      completedStepCount={0}
      setupReady={false}
      error=""
      isLiveRestricted={false}
      isLoading={true}
      isRefreshDisabled={true}
      message=""
      onChangeTab={noop}
      onDismissError={noop}
      onDismissMessage={noop}
      onRefresh={noop}
      setupSteps={pendingSetupSteps}
      showContent={false}
      showLoading={true}
    >
      {null}
    </BillingPageFrame>
  );
}
