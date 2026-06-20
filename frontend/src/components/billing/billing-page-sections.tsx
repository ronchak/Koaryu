"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  CheckCircle2,
  Clock3,
  CreditCard,
  Link2,
  Mail,
  RefreshCw,
  type LucideIcon,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { OverviewMetricCard } from "@/components/ui/overview";
import { formatMoney, statusTone } from "@/lib/billing-page-utils";
import type {
  PlatformBillingStatus,
  StudioPaymentAccount,
} from "@/types";
import type { BillingPlan } from "@/types";

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
    <span className={`inline-flex items-center rounded-[4px] border px-2 py-0.5 text-[11px] font-medium ${statusTone(status)}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-border bg-surface rounded-[6px] p-4">
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
    <span className="inline-flex items-center gap-1 rounded-[4px] border border-border px-2 py-0.5 text-xs text-text-secondary">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: program.program_color_hex || "#94A3B8" }} />
      {program.program_name || "Program"}
    </span>
  );
}

export function BillingOverviewTab({
  activeStudents,
  activeSubscriptionCount,
  billingConnect,
  billingInvoicesLength,
  billingPaymentsLength,
  billingPeriod,
  billingPlatform,
  canManageKoaryuSubscription,
  canOpenCustomerPortal,
  canOpenStripeDashboard,
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
  stripePaymentTotal,
  studentsLoaded,
}: {
  activeStudents: number;
  activeSubscriptionCount: number;
  billingConnect: StudioPaymentAccount | null;
  billingInvoicesLength: number;
  billingPaymentsLength: number;
  billingPeriod: BillingPeriodCopy;
  billingPlatform: PlatformBillingStatus | null;
  canManageKoaryuSubscription: boolean;
  canOpenCustomerPortal: boolean;
  canOpenStripeDashboard: boolean;
  connectActionLabel: string;
  connectRequirementItems: ConnectRequirementItem[];
  externalPaymentTotal: number;
  failedInvoiceCount: number;
  hasStripeConnectedAccount: boolean;
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  onConnectClick: () => void;
  onConnectReset: () => void;
  openBillingLink: OpenBillingLink;
  openInvoiceTotal: number;
  paidRevenue: number;
  stripePaymentTotal: number;
  studentsLoaded: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard
          icon={Banknote}
          label="Collected"
          value={formatMoney(paidRevenue)}
          helper={`${billingPaymentsLength} payment records this month`}
          tone="success"
        />
        <OverviewMetricCard
          icon={CreditCard}
          label="Open Balance"
          value={formatMoney(openInvoiceTotal)}
          helper={`${billingInvoicesLength} invoices tracked`}
          tone={openInvoiceTotal > 0 ? "warning" : "neutral"}
        />
        <OverviewMetricCard
          icon={AlertTriangle}
          label="Needs Attention"
          value={failedInvoiceCount}
          helper="Families with failed or past-due tuition"
          tone={failedInvoiceCount > 0 ? "danger" : "neutral"}
        />
        <OverviewMetricCard
          icon={Users}
          label="Student Billing"
          value={studentsLoaded ? String(activeStudents) : "Loading"}
          helper={`${activeSubscriptionCount} active billing subscriptions`}
          tone="info"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="border border-border bg-surface rounded-[6px] p-5">
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
              disabled={!canManageKoaryuSubscription || isActionLoading}
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
              disabled={!canOpenCustomerPortal || isActionLoading}
              isLoading={isLoadingAction("portal")}
              title={canOpenCustomerPortal ? undefined : "Available after Koaryu Core checkout creates a Stripe customer."}
              onClick={() => void openBillingLink("/platform-billing/portal", {
                return_url: window.location.href,
              }, "portal")}
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              {isLoadingAction("portal") ? "Opening portal..." : "Customer portal"}
            </Button>
          </div>
        </section>

        <section className="border border-border bg-surface rounded-[6px] p-5">
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
              <p className="text-xs text-muted">Stripe revenue</p>
              <p className="mt-1 text-sm text-text-primary">{formatMoney(stripePaymentTotal)}</p>
            </div>
            <div>
              <p className="text-xs text-muted">External revenue</p>
              <p className="mt-1 text-sm text-text-primary">{formatMoney(externalPaymentTotal)}</p>
            </div>
          </div>
          {billingConnect?.stripe_connected_account_id ? (
            <div className="mt-4 rounded-[6px] border border-border bg-surface-raised/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-text-secondary">Stripe onboarding checklist</p>
                <span className="text-[11px] text-muted">
                  {connectRequirementItems.filter((item) => item.complete).length} / {connectRequirementItems.length} complete
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {connectRequirementItems.map((item) => (
                  <div key={item.id} className="flex items-start gap-2 rounded-[6px] border border-border bg-bg/40 px-2.5 py-2">
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
              disabled={!canManageKoaryuSubscription || isActionLoading}
              isLoading={isLoadingAction("connect")}
              onClick={onConnectClick}
            >
              <Link2 className="h-3.5 w-3.5" />
              {isLoadingAction("connect") ? "Opening Stripe..." : connectActionLabel}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!canOpenStripeDashboard || !canManageKoaryuSubscription || isActionLoading}
              isLoading={isLoadingAction("dashboard")}
              title={canOpenStripeDashboard ? "Open Stripe to review account status, requirements, payments, and payouts." : "Available after Stripe Connect creates an account."}
              onClick={() => void openBillingLink("/billing/connect/dashboard-link", {
                return_url: window.location.href,
              }, "dashboard")}
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              {isLoadingAction("dashboard") ? "Opening Stripe..." : "Stripe dashboard"}
            </Button>
            {hasStripeConnectedAccount ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canManageKoaryuSubscription || isActionLoading}
                isLoading={isLoadingAction("connect-reset")}
                title="Use only before real Stripe billing history exists. Koaryu blocks reconnects once this studio has live Stripe billing history."
                onClick={onConnectReset}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {isLoadingAction("connect-reset") ? "Clearing..." : "Reconnect Stripe"}
              </Button>
            ) : null}
          </div>
        </section>
      </div>

      <section className="border border-border bg-surface rounded-[6px] p-5">
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
              {billingPlatform?.email_usage.sent || 0} of {billingPlatform?.email_usage.included || 500} emails used this month. Overage is $0.002 per email. SMS is not included in v1.
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium text-text-primary">{formatMoney(billingPlatform?.email_usage.estimated_overage_cents || 0)}</p>
            <p className="text-xs text-muted">Estimated overage</p>
          </div>
        </div>
      </section>
    </div>
  );
}
