"use client";

import { useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Clock3,
  CreditCard,
  Download,
  FileText,
  Info,
  ListChecks,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { BillingContentPlaceholder } from "./billing-page-loading";
import { resolveBillingProviderCopy } from "@/lib/billing-policy";
import { formatMoney } from "@/lib/billing-page-utils";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { HorizonPage, HorizonStats, ToneChip, type HorizonStat } from "@/components/ui/horizon";
import { SetupStepList, type SetupStep } from "@/components/ui/overview";
import { SectionHeader } from "./billing-page-sections";
import { BILLING_TABS, getBillingUrlForTab, type BillingTab } from "@/lib/billing-page-state";
import styles from "./billing.module.css";

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

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The money facts the page already loads; the strip never derives a figure of its own. */
export type BillingMoneySummary = {
  activeStudents: number;
  activeSubscriptionCount: number;
  billingObservedAt: string | null;
  currentMonthPaymentCount: number;
  failedInvoiceCount: number;
  openInvoiceTotal: number;
  paidRevenue: number;
  paymentCohortAvailable: boolean;
  studentsLoaded: boolean;
};

/** Exceptions first: what needs attention, what is owed, what came in, who is covered. */
export function BillingMoneyStats({
  pending = false,
  summary,
}: {
  pending?: boolean;
  summary: BillingMoneySummary | null;
}) {
  const cohort = summary?.paymentCohortAvailable ?? false;
  const failed = summary?.failedInvoiceCount ?? 0;
  const items: HorizonStat[] = [
    {
      id: "attention",
      label: "Needs attention",
      pending,
      value: cohort ? String(failed) : undefined,
      note: cohort ? "Failed or past-due tuition" : "Unavailable",
      tone: cohort && failed > 0 ? "alert" : undefined,
      href: getBillingUrlForTab("", "invoices"),
    },
    {
      id: "receivables",
      label: "Open receivables",
      pending,
      value: cohort && summary ? formatMoney(summary.openInvoiceTotal) : undefined,
      note: cohort ? "All outstanding invoices" : "Unavailable",
      href: getBillingUrlForTab("", "invoices"),
    },
    {
      id: "collected",
      label: "Collected this UTC month",
      pending,
      value: cohort && summary ? formatMoney(summary.paidRevenue) : undefined,
      note:
        cohort && summary
          ? `${plural(summary.currentMonthPaymentCount, "payment")}, net of adjustments`
          : "Complete cohort could not be loaded",
      href: getBillingUrlForTab("", "reports"),
    },
    {
      id: "coverage",
      label: "Student coverage",
      pending,
      value: summary?.studentsLoaded ? String(summary.activeStudents) : undefined,
      note: summary?.studentsLoaded
        ? `${plural(summary.activeSubscriptionCount, "active subscription")}`
        : "Student totals unavailable",
      href: getBillingUrlForTab("", "enrollments"),
    },
  ];
  return (
    <div className={styles.money}>
      <HorizonStats items={items} label="Billing exceptions and receivables" />
      {pending ? null : (
        <p className={styles.scope}>
          Scope: current studio · Observed{" "}
          {summary?.billingObservedAt ? (
            <time dateTime={summary.billingObservedAt}>
              {new Date(summary.billingObservedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
            </time>
          ) : (
            "unavailable"
          )}{" "}
          · Current UTC-month net collected after confirmed adjustments
        </p>
      )}
    </div>
  );
}

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
  moneySummary = null,
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
  /** Omitted while billing has not loaded; the strip then holds its place. */
  moneySummary?: BillingMoneySummary | null;
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
      <Header
        title="Billing"
        description="What needs attention, who pays for what, and what has come in."
      >
        <Button
          variant="ghost"
          size="md"
          onClick={onRefresh}
          disabled={isRefreshDisabled}
          isLoading={isLoading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
          {isLoading ? "Refreshing..." : "Refresh"}
        </Button>
      </Header>

      <div
        className={styles.body}
        data-billing-ledger="six-views"
        aria-busy={isLoading || showLoading}
      >
        <HorizonPage>
          {isLiveRestricted ? (
            <BillingAccessLimitedNotice />
          ) : (
            <>
              <BillingMoneyStats
                pending={showLoading}
                summary={showContent ? moneySummary : null}
              />

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

              <p className={styles.boundary}>
                <Info aria-hidden="true" />
                <span>{billingBoundaryMessage}</span>
              </p>

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
        </HorizonPage>
      </div>
    </OperationsSurface>
  );
}

export function BillingAccessLimitedNotice() {
  return (
    <section className="rounded-[16px] border border-border bg-surface p-5 shadow-[var(--product-shadow-card)]">
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
  const complete = ready && completedStepCount >= steps.length;
  // Open while steps remain; once everything is ready the review folds to one line.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? (ready && !complete);
  return (
    <>
      <section className={styles.review} data-billing-setup-register="true">
        <div className={styles.reviewBar}>
          <ToneChip tone={!ready ? "neutral" : complete ? "calm" : "warn"} size={32}>
            {complete ? <CheckCircle2 /> : <Clock3 />}
          </ToneChip>
          <div className={styles.reviewText}>
            <h2 className={styles.reviewTitle}>Billing review</h2>
            <p className={styles.reviewCount}>
              {ready ? `${completedStepCount} of ${steps.length} ready` : "Review status pending"}
              <span className={styles.reviewWhy}>
                {" · "}
                Review provider state, plans, and families before posting external payments or
                reconciling open invoices.
              </span>
            </p>
          </div>
          {ready ? (
            <span className={styles.reviewMeter} aria-hidden="true">
              {steps.map((step) => (
                <span key={step.id} data-complete={step.complete ? "true" : undefined} />
              ))}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.reviewToggle}
            aria-expanded={expanded}
            aria-controls="billing-review-steps"
            onClick={() => setToggled(!expanded)}
          >
            {expanded ? "Hide steps" : "Show steps"}
            <ChevronDown aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <div id="billing-review-steps" className={styles.reviewSteps} hidden={!expanded}>
          <SetupStepList steps={steps} />
        </div>
      </section>

      <nav
        className={styles.views}
        aria-label="Billing views"
        data-billing-book-index="six-views"
        data-print-hide="true"
      >
        <ol className={styles.viewList}>
          {BILLING_TABS.map((tab) => {
            const { icon: Icon, label } = BILLING_TAB_PRESENTATION[tab];
            const isActive = activeTab === tab;
            return (
              <li key={tab}>
                <button
                  type="button"
                  onClick={() => onChangeTab(tab)}
                  aria-pressed={isActive}
                  className={styles.view}
                >
                  <Icon aria-hidden="true" />
                  <span>{label}</span>
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
        <DismissibleNotice tone="success" onDismiss={onDismissMessage} className="text-sm">
          {message}
        </DismissibleNotice>
      ) : null}
      {error ? (
        <DismissibleNotice tone="danger" onDismiss={onDismissError} className="text-sm">
          {error}
        </DismissibleNotice>
      ) : null}
    </>
  );
}

export function BillingPolicyNote() {
  return (
    <p className={styles.policy}>
      <span>
        <CheckCircle2 aria-hidden="true" className="text-success" />
        No student-count pricing. No staff-count pricing. No feature gates.
      </span>
      <span>
        <Clock3 aria-hidden="true" className="text-warning" />
        Soft student alert at 1,500 active students, with no database lockout.
      </span>
    </p>
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
