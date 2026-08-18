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
import { OperationsSurface } from "@/components/operations/operations-surface";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import {
  SetupStepList,
  type SetupStep,
} from "@/components/ui/overview";
import { SectionHeader } from "./billing-page-sections";

export type BillingTab = "overview" | "plans" | "families" | "enrollments" | "invoices" | "reports";
export type BillingSetupStep = SetupStep;

const BILLING_TABS = [
  { id: "overview", label: "Setup", icon: ListChecks },
  { id: "plans", label: "Tuition Plans", icon: Receipt },
  { id: "families", label: "Families", icon: Users },
  { id: "enrollments", label: "Student Billing", icon: CreditCard },
  { id: "invoices", label: "Invoices", icon: FileText },
  { id: "reports", label: "Advanced", icon: Download },
] as const;

export function BillingPageFrame({
  activeTab,
  billingBoundaryMessage,
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
  showContent,
  showLoading,
}: {
  activeTab: BillingTab;
  billingBoundaryMessage: string;
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
  showContent: boolean;
  showLoading: boolean;
}) {
  return (
    <OperationsSurface page="billing">
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

      <div className="flex-1 p-4 sm:p-6" data-billing-ledger="six-books">
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

              <section className="grid border-y border-border bg-surface text-xs sm:grid-cols-3" data-billing-register-context="true">
                <div className="border-b border-border px-4 py-3 sm:border-b-0 sm:border-r"><strong className="block uppercase tracking-widest text-muted">Scope</strong><span className="mt-1 block text-text-primary">Current studio</span></div>
                <div className="border-b border-border px-4 py-3 sm:border-b-0 sm:border-r"><strong className="block uppercase tracking-widest text-muted">As of</strong><span className="mt-1 block text-text-primary">Latest loaded billing refresh</span></div>
                <div className="px-4 py-3"><strong className="block uppercase tracking-widest text-muted">Values</strong><span className="mt-1 block text-text-primary">Exact integer cents, formatted for display</span></div>
              </section>

              <section className="rounded-[6px] border border-warning/40 bg-warning/5 p-4 text-xs text-text-secondary">
                {billingBoundaryMessage}
              </section>

              {showContent ? children : null}

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
      <section className="border-y-2 border-border bg-surface" data-billing-setup-register="true">
        <div className="grid border-b border-border px-4 py-4 sm:grid-cols-[minmax(12rem,0.35fr)_1fr] sm:gap-8 sm:px-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">{completedStepCount} of {steps.length} ready</p>
            <h2 className="mt-1 text-base font-semibold text-text-primary">Billing review</h2>
          </div>
          <p className="text-xs leading-5 text-text-secondary">
            Review provider state, plans, and families before posting external payments or reconciling open invoices.
          </p>
        </div>
        <SetupStepList steps={steps} />
      </section>

      <nav className="border-y border-border bg-surface" aria-label="Billing books" data-billing-book-index="six-books" data-print-hide="true">
        <ol className="grid list-none grid-cols-2 p-0 sm:grid-cols-3 xl:grid-cols-6">
          {BILLING_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <li key={tab.id} className="border-b border-r border-border last:border-r-0 sm:[&:nth-last-child(-n+3)]:border-b-0 xl:border-b-0">
                <button
                  type="button"
                  onClick={() => onChangeTab(tab.id)}
                  aria-pressed={isActive}
                  className={`grid min-h-16 w-full grid-cols-[1fr_auto] items-center gap-x-2 border-t-2 px-3 py-2 text-left ${isActive ? "border-accent bg-accent/10 text-text-primary" : "border-transparent text-text-secondary hover:bg-surface-raised"}`}
                >
                  <strong className="text-xs font-semibold">{tab.label}</strong>
                  <Icon aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
                  <span className="col-span-2 mt-1 text-[10px] uppercase tracking-widest text-muted">
                    {isActive ? "Open book" : "View book"}
                  </span>
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
