"use client";

import { useState } from "react";

import {
  ArrowUpRight,
  Banknote,
  CheckCircle2,
  Clock3,
  CreditCard,
  Link2,
  Mail,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalFrame } from "@/components/ui/modal-frame";
import { formatMoney, statusTone } from "@/lib/billing-page-utils";
import type {
  PlatformBillingStatus,
  StudioPaymentAccount,
} from "@/types";
import type { BillingPlan } from "@/types";
import { canStartCoreCheckout, type BillingProviderCopy } from "@/lib/billing-policy";

type BillingPeriodCopy = {
  label: string;
  value: string;
};

type ConnectRequirementItem = {
  id: string;
  label: string;
  description: string;
  complete: boolean;
};

type OpenBillingLink = (
  path: string,
  body: Record<string, string | undefined>,
  action?: string
) => Promise<void>;

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone(status)}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[14px] border border-border bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text-primary">{value}</p>
      {hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

export function SectionHeader({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description?: string }) {
  return (
    <div className="mb-4 flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 text-accent" />
      <div>
        <h2 className="text-sm font-medium text-text-primary">{title}</h2>
        {description ? <p className="mt-1 text-xs text-muted">{description}</p> : null}
      </div>
    </div>
  );
}

export function ProgramChip({ program }: { program: BillingPlan["programs"][number] }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: program.program_color_hex || "#94A3B8" }} />
      {program.program_name || "Program"}
    </span>
  );
}

export function BillingOverviewTab({
  activeStudents,
  billingObservedAt,
  activeSubscriptionCount,
  billingConnect,
  currentMonthPaymentCount,
  billingPeriod,
  billingPlatform,
  billingProviderCopy,
  canManageKoaryuSubscription,
  canOpenCustomerPortal,
  canOpenStripeDashboard,
  canResetConnect,
  connectActionLabel,
  connectRequirementItems,
  externalPaymentTotal,
  failedInvoiceCount,
  hasStripeConnectedAccount,
  isActionLoading,
  isLoadingAction,
  onConnectClick,
  onConnectReset,
  openBillingLink,
  openInvoiceTotal,
  paidRevenue,
  paymentCohortAvailable,
  stripePaymentTotal,
  studentsLoaded,
  coreCheckoutEnabled,
  corePortalEnabled,
  connectDashboardEnabled,
  connectOnboardingEnabled,
}: {
  activeStudents: number;
  activeSubscriptionCount: number;
  billingConnect: StudioPaymentAccount | null;
  billingObservedAt: string | null;
  currentMonthPaymentCount: number;
  billingPeriod: BillingPeriodCopy;
  billingPlatform: PlatformBillingStatus | null;
  billingProviderCopy: BillingProviderCopy;
  canManageKoaryuSubscription: boolean;
  canOpenCustomerPortal: boolean;
  canOpenStripeDashboard: boolean;
  canResetConnect: boolean;
  connectActionLabel: string;
  connectRequirementItems: ConnectRequirementItem[];
  externalPaymentTotal: number;
  failedInvoiceCount: number;
  hasStripeConnectedAccount: boolean;
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  onConnectClick: () => void;
  onConnectReset: () => Promise<void>;
  openBillingLink: OpenBillingLink;
  openInvoiceTotal: number;
  paidRevenue: number;
  paymentCohortAvailable: boolean;
  stripePaymentTotal: number;
  studentsLoaded: boolean;
  coreCheckoutEnabled: boolean;
  corePortalEnabled: boolean;
  connectDashboardEnabled: boolean;
  connectOnboardingEnabled: boolean;
}) {
  const coreCheckoutAvailable = canStartCoreCheckout(billingPlatform);
  const [showConnectResetConfirm, setShowConnectResetConfirm] = useState(false);
  const moneyBand = [
    { label: "Needs attention", value: paymentCohortAvailable ? String(failedInvoiceCount) : "Unavailable", helper: "Failed or past-due tuition", tone: "exception" },
    { label: "Open receivables", value: paymentCohortAvailable ? formatMoney(openInvoiceTotal) : "Unavailable", helper: "All outstanding invoices", tone: "receivable" },
    {
      label: "Collected this UTC month",
      value: paymentCohortAvailable ? formatMoney(paidRevenue) : "Unavailable",
      helper: paymentCohortAvailable
        ? `${currentMonthPaymentCount} payments, net of confirmed adjustments`
        : "Complete cohort could not be loaded",
      tone: "collected",
    },
    { label: "Student coverage", value: studentsLoaded ? String(activeStudents) : "Unavailable", helper: studentsLoaded ? `${activeSubscriptionCount} active subscriptions` : "Student totals unavailable", tone: "coverage" },
  ];

  return (
    <div className="space-y-5">
      <section className="overflow-hidden bg-surface" aria-label="Billing exceptions and receivables" data-billing-money-band="exceptions-first">
        <div className="grid gap-2 p-2 sm:grid-cols-2 xl:grid-cols-4">
          {moneyBand.map((metric) => (
            <div key={metric.label} data-ledger-tone={metric.tone} className="rounded-[10px] bg-surface-raised/50 p-4">
              <p className="text-xs font-medium text-muted">{metric.label}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-text-primary">{metric.value}</p>
              <p className="mt-1 text-xs leading-5 text-text-secondary">{metric.helper}</p>
            </div>
          ))}
        </div>
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted">
          Scope: current studio · Observed {billingObservedAt ? <time dateTime={billingObservedAt}>{new Date(billingObservedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC</time> : "unavailable"} · Current UTC-month net collected after confirmed adjustments
        </p>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-[14px] border border-border bg-surface p-4">
          <SectionHeader icon={CreditCard} title="Koaryu Core" description="One flat software subscription: no student caps, no staff caps, no feature gates." />
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
            <div>
              <p className="text-2xl font-semibold text-text-primary">
                {billingPlatform ? formatMoney(billingPlatform.monthly_price_cents, billingPlatform.currency) : "$27"}
                <span className="text-sm font-normal text-muted"> / month</span>
              </p>
              <p className="mt-1 text-xs text-muted">30-day trial for new studios. Single physical location per subscription.</p>
            </div>
            {billingPlatform ? <StatusPill status={billingPlatform.status} /> : <StatusPill status="admin_managed" />}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted">{billingPeriod.label}</p>
              <p className="mt-1 text-sm text-text-primary">{billingPeriod.value}</p>
            </div>
            <div>
              <p className="text-xs text-muted">Plan policy</p>
              <p className="mt-1 text-sm text-text-primary">All modules included</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!coreCheckoutEnabled || !canManageKoaryuSubscription || !coreCheckoutAvailable || isActionLoading}
              title={!coreCheckoutAvailable
                ? billingPlatform?.comped || billingPlatform?.status === "comped"
                  ? "Koaryu Core access is comped for this studio. No checkout is required."
                  : billingPlatform && ["active", "trialing", "past_due", "unpaid", "paused"].includes(billingPlatform.status)
                    ? "Koaryu Core billing already exists. Use the billing portal to manage it."
                    : "Koaryu Core checkout is currently unavailable."
                : coreCheckoutEnabled
                  ? undefined
                  : billingProviderCopy.coreSubscription}
              isLoading={isLoadingAction("checkout")}
              onClick={() => void openBillingLink("/platform-billing/checkout", {
                success_url: window.location.href,
                cancel_url: window.location.href,
              }, "checkout")}
            >
              <CreditCard className="h-3.5 w-3.5" />
              {isLoadingAction("checkout") ? "Opening Stripe..." : "Start checkout"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!corePortalEnabled || !canOpenCustomerPortal || isActionLoading}
              isLoading={isLoadingAction("portal")}
              title={!corePortalEnabled
                ? billingProviderCopy.coreSubscription
                : canOpenCustomerPortal
                  ? undefined
                  : "Available after Koaryu Core checkout creates a Stripe customer."}
              onClick={() => void openBillingLink("/platform-billing/portal", {
                return_url: window.location.href,
              }, "portal")}
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              {isLoadingAction("portal") ? "Opening portal..." : "Customer portal"}
            </Button>
          </div>
        </section>

        <section className="rounded-[14px] border border-border bg-surface p-4">
          <SectionHeader icon={Banknote} title="Koaryu Payments" description="Optional Stripe Connect add-on. Koaryu collects 0.5% only on successful processed transactions." />
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
            <div>
              <p className="text-sm font-medium text-text-primary">
                {billingConnect?.charges_enabled ? "Stripe connected" : "Stripe not charging yet"}
              </p>
              <p className="mt-1 text-xs text-muted">Cash, checks, Zelle, Venmo, and outside processors cost nothing extra.</p>
            </div>
            {billingConnect ? <StatusPill status={billingConnect.status} /> : <StatusPill status="not_connected" />}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted">Application fee</p>
              <p className="mt-1 text-sm text-text-primary">{billingConnect ? `${billingConnect.platform_fee_bps / 100}%` : "0.5%"} on successful charges</p>
            </div>
            <div>
              <p className="text-xs text-muted">Chargeback liability</p>
              <p className="mt-1 text-sm text-text-primary">Studio account</p>
            </div>
            <div>
              <p className="text-xs text-muted">UTC-month Stripe payment cohort</p>
              <p className="mt-1 text-sm text-text-primary">{formatMoney(stripePaymentTotal)}</p>
              <p className="mt-1 text-[11px] text-muted">
                {billingProviderCopy.connectPayments}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted">UTC-month external payment cohort</p>
              <p className="mt-1 text-sm text-text-primary">{formatMoney(externalPaymentTotal)}</p>
            </div>
          </div>
          {billingConnect?.stripe_connected_account_id ? (
            <div className="mt-4 rounded-[10px] bg-surface-raised/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-text-secondary">Stripe onboarding checklist</p>
                <span className="text-[11px] text-muted">
                  {connectRequirementItems.filter((item) => item.complete).length} / {connectRequirementItems.length} complete
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {connectRequirementItems.map((item) => (
                  <div key={item.id} className="flex items-start gap-2 rounded-[10px] bg-bg/40 px-2.5 py-2">
                    {item.complete ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-success" />
                    ) : (
                      <Clock3 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-text-primary">{item.label}</p>
                      <p className="mt-0.5 text-[11px] leading-4 text-muted">{item.complete ? "Received by Stripe" : item.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!connectOnboardingEnabled || !canManageKoaryuSubscription || isActionLoading}
              title={connectOnboardingEnabled ? undefined : billingProviderCopy.connectOnboarding}
              isLoading={isLoadingAction("connect")}
              onClick={onConnectClick}
            >
              <Link2 className="h-3.5 w-3.5" />
              {isLoadingAction("connect") ? "Opening Stripe..." : connectActionLabel}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!connectDashboardEnabled || !canOpenStripeDashboard || !canManageKoaryuSubscription || isActionLoading}
              isLoading={isLoadingAction("dashboard")}
              title={!connectDashboardEnabled
                ? billingProviderCopy.connectOnboarding
                : canOpenStripeDashboard
                  ? "Open Stripe to review account status, requirements, payments, and payouts."
                  : "Available after Stripe Connect creates an account."}
              onClick={() => void openBillingLink("/billing/connect/dashboard-link", {
                return_url: window.location.href,
              }, "dashboard")}
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              {isLoadingAction("dashboard") ? "Opening Stripe..." : "Stripe dashboard"}
            </Button>
            {hasStripeConnectedAccount ? (
              <span className="self-center text-xs text-muted">Reconnect is currently unavailable.</span>
            ) : null}
            {canResetConnect ? (
              <Button
                variant="danger"
                size="sm"
                disabled={isActionLoading}
                onClick={() => setShowConnectResetConfirm(true)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset connection
              </Button>
            ) : null}
          </div>
        </section>
      </div>

      <section className="rounded-[14px] border border-border bg-surface p-4">
        <SectionHeader icon={Mail} title="Message usage" description="Automation is included for every studio. Only email volume above the included monthly allowance is metered." />
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <div className="h-2 rounded-full bg-surface-raised">
              <div
                className="h-2 rounded-full bg-accent"
                style={{ width: `${Math.min(100, ((billingPlatform?.email_usage.sent || 0) / (billingPlatform?.email_usage.included || 500)) * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              {billingPlatform?.email_usage.sent || 0} of {billingPlatform?.email_usage.included || 500} emails used this month. Overage is $0.002 per email.
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium text-text-primary">{formatMoney(billingPlatform?.email_usage.estimated_overage_cents || 0)}</p>
            <p className="text-xs text-muted">Estimated overage</p>
          </div>
        </div>
      </section>
      {showConnectResetConfirm ? (
        <ModalFrame
          role="alertdialog"
          ariaLabelledBy="connect-reset-title"
          ariaDescribedBy="connect-reset-description"
          panelClassName="w-[min(92vw,30rem)] rounded-[18px] bg-surface p-4"
          onBackdropClick={() => setShowConnectResetConfirm(false)}
        >
          <h2 id="connect-reset-title" className="text-base font-semibold text-text-primary">Reset Stripe connection?</h2>
          <p id="connect-reset-description" className="mt-2 text-sm leading-6 text-text-secondary">
            This clears Koaryu&apos;s current connected-account reference so an admin can start onboarding again. Existing provider history is not edited here.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowConnectResetConfirm(false)}>Keep connection</Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              isLoading={isLoadingAction("connect-reset")}
              disabled={!canResetConnect || isActionLoading}
              onClick={() => {
                setShowConnectResetConfirm(false);
                void onConnectReset();
              }}
            >
              Reset connection
            </Button>
          </div>
        </ModalFrame>
      ) : null}
    </div>
  );
}
