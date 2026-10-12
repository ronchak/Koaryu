"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { billingOverviewMetricsClass, billingOverviewProvidersClass } from "./billing-layout";

import { ArrowUpRight, CheckCircle2, Clock3, CreditCard, Link2, RotateCcw, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CalmState, HorizonPanel, ToneTag, type HorizonTone } from "@/components/ui/horizon";
import { ModalFrame } from "@/components/ui/modal-frame";
import { formatMoney } from "@/lib/billing-page-utils";
import type { PlatformBillingStatus, StudioPaymentAccount } from "@/types";
import type { BillingPlan } from "@/types";
import { canStartCoreCheckout, type BillingProviderCopy } from "@/lib/billing-policy";
import styles from "./billing.module.css";

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
  action?: string,
) => Promise<void>;

const ALERT_STATUSES = new Set([
  "past_due",
  "failed",
  "unpaid",
  "action_required",
  "deauthorized",
  "uncollectible",
  "disputed",
]);
const WARN_STATUSES = new Set([
  "pending",
  "open",
  "upcoming",
  "onboarding_incomplete",
  "incomplete",
  "incomplete_expired",
  "paused",
  "partially_refunded",
  "refunded",
  "pending_setup",
]);
const CALM_STATUSES = new Set([
  "active",
  "current",
  "paid",
  "succeeded",
  "charges_enabled",
  "trialing",
  "externally_recorded",
  "externally_paid",
  "enabled",
  "comped",
]);

/** Billing states mapped onto Horizon tones; the status words always stay visible. */
export function billingStatusTone(status: string): HorizonTone {
  if (ALERT_STATUSES.has(status)) return "alert";
  if (WARN_STATUSES.has(status)) return "warn";
  if (CALM_STATUSES.has(status)) return "calm";
  return "neutral";
}

export function StatusPill({ status }: { status: string }) {
  return (
    <ToneTag tone={billingStatusTone(status)} className={styles.statusTag}>
      {status.replace(/_/g, " ")}
    </ToneTag>
  );
}

/** A Horizon panel for billing content. */
export const BillingPanel = HorizonPanel;

/** The one empty state of a flush ledger panel. */
export function BillingEmpty({ title }: { title: string }) {
  return (
    <div className={styles.inset}>
      <CalmState tone="neutral" title={title} />
    </div>
  );
}

/** Payer balances, each amount independent: a missing fact reads "Unavailable", never zero. */
export function PayerBalances({
  balanceCents,
  overdueCents,
  tone,
  uncollectibleCents,
}: {
  balanceCents: number;
  overdueCents?: number | null;
  tone?: "alert";
  uncollectibleCents?: number | null;
}) {
  return (
    <dl className={styles.amounts} data-tone={tone}>
      <div>
        <dt>Outstanding</dt>
        <dd>{formatMoney(balanceCents)}</dd>
      </div>
      <div>
        <dt>Overdue</dt>
        <dd>{overdueCents == null ? "Unavailable" : formatMoney(overdueCents)}</dd>
      </div>
      <div>
        <dt>Uncollectible</dt>
        <dd>{uncollectibleCents == null ? "Unavailable" : formatMoney(uncollectibleCents)}</dd>
      </div>
    </dl>
  );
}

export function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={styles.figure}>
      <p className={styles.figureLabel}>{label}</p>
      <p className={styles.figureValue}>{value}</p>
      {hint ? <p className={styles.figureHint}>{hint}</p> : null}
    </div>
  );
}

export function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <div className={`mb-4 ${styles.sectionHead}`}>
      <span className="mt-0.5 inline-grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-[var(--hz-tile)] text-accent">
        <Icon aria-hidden="true" className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
    </div>
  );
}

export function ProgramChip({ program }: { program: BillingPlan["programs"][number] }) {
  return (
    <span className={styles.programChip}>
      <span
        aria-hidden="true"
        className={styles.programDot}
        style={
          program.program_color_hex
            ? ({ "--program-color": program.program_color_hex } as CSSProperties)
            : undefined
        }
      />
      {program.program_name || "Program"}
    </span>
  );
}

function Fact({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-sm font-semibold text-text-primary ${styles.factValue}`}>{children}</p>
      {hint ? <p className="mt-1 text-xs leading-5 text-muted">{hint}</p> : null}
    </div>
  );
}

export function BillingOverviewTab({
  billingConnect,
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
  hasStripeConnectedAccount,
  isActionLoading,
  isLoadingAction,
  onConnectClick,
  onConnectReset,
  openBillingLink,
  paymentCohortAvailable,
  stripePaymentTotal,
  coreCheckoutEnabled,
  corePortalEnabled,
  connectDashboardEnabled,
  connectOnboardingEnabled,
}: {
  activeStudents?: number;
  activeSubscriptionCount?: number;
  billingConnect: StudioPaymentAccount | null;
  billingObservedAt?: string | null;
  currentMonthPaymentCount?: number;
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
  failedInvoiceCount?: number;
  hasStripeConnectedAccount: boolean;
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  onConnectClick: () => void;
  onConnectReset: () => Promise<void>;
  openBillingLink: OpenBillingLink;
  openInvoiceTotal?: number;
  paidRevenue?: number;
  paymentCohortAvailable: boolean;
  stripePaymentTotal: number;
  studentsLoaded?: boolean;
  coreCheckoutEnabled: boolean;
  corePortalEnabled: boolean;
  connectDashboardEnabled: boolean;
  connectOnboardingEnabled: boolean;
}) {
  const coreCheckoutAvailable = canStartCoreCheckout(billingPlatform);
  const [showConnectResetConfirm, setShowConnectResetConfirm] = useState(false);
  const emailUsage = billingPlatform?.email_usage;
  const emailUsageProgress =
    emailUsage && emailUsage.included > 0
      ? Math.min(100, (emailUsage.sent / emailUsage.included) * 100)
      : null;
  const connectCompleteCount = connectRequirementItems.filter((item) => item.complete).length;
  const checkoutBlocked = !canManageKoaryuSubscription || !coreCheckoutAvailable || isActionLoading;
  const portalBlocked = !canOpenCustomerPortal || isActionLoading;
  const onboardingBlocked = !canManageKoaryuSubscription || isActionLoading;
  const dashboardBlocked = !canOpenStripeDashboard || !canManageKoaryuSubscription || isActionLoading;

  return (
    <div className="space-y-5">
      <div className={billingOverviewProvidersClass}>
        <BillingPanel
          title="Koaryu Core"
          description="One flat software subscription: no student caps, no staff caps, no feature gates."
          actions={
            billingPlatform ? (
              <StatusPill status={billingPlatform.status} />
            ) : (
              <StatusPill status="admin_managed" />
            )
          }
        >
          <div className="border-b border-border pb-4">
            <p className={styles.price}>
              {billingPlatform
                ? formatMoney(billingPlatform.monthly_price_cents, billingPlatform.currency)
                : "$27"}
              <small>/ month</small>
            </p>
            <p className="mt-1.5 text-xs text-muted">
              30-day trial for new studios. Single physical location per subscription.
            </p>
          </div>
          <div className={`mt-4 ${billingOverviewMetricsClass}`}>
            <Fact label={billingPeriod.label}>{billingPeriod.value}</Fact>
            <Fact label="Plan policy">All modules included</Fact>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="md"
              disabled={!coreCheckoutEnabled || checkoutBlocked}
              title={
                !coreCheckoutAvailable
                  ? billingPlatform?.comped || billingPlatform?.status === "comped"
                    ? "Koaryu Core access is comped for this studio. No checkout is required."
                    : billingPlatform &&
                        ["active", "trialing", "past_due", "unpaid", "paused"].includes(
                          billingPlatform.status,
                        )
                      ? "Koaryu Core billing already exists. Use the billing portal to manage it."
                      : "Koaryu Core checkout is currently unavailable."
                  : coreCheckoutEnabled
                    ? undefined
                    : billingProviderCopy.coreSubscription
              }
              isLoading={isLoadingAction("checkout")}
              onClick={() =>
                void openBillingLink(
                  "/platform-billing/checkout",
                  {
                    success_url: window.location.href,
                    cancel_url: window.location.href,
                  },
                  "checkout",
                )
              }
            >
              <CreditCard className="h-3.5 w-3.5" />
              {isLoadingAction("checkout") ? "Opening Stripe..." : "Start checkout"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              disabled={!corePortalEnabled || portalBlocked}
              isLoading={isLoadingAction("portal")}
              title={
                !corePortalEnabled
                  ? billingProviderCopy.coreSubscription
                  : canOpenCustomerPortal
                    ? undefined
                    : "Available after Koaryu Core checkout creates a Stripe customer."
              }
              onClick={() =>
                void openBillingLink(
                  "/platform-billing/portal",
                  {
                    return_url: window.location.href,
                  },
                  "portal",
                )
              }
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              {isLoadingAction("portal") ? "Opening portal..." : "Customer portal"}
            </Button>
          </div>
        </BillingPanel>

        <BillingPanel
          title="Koaryu Payments"
          description="Optional Stripe Connect add-on. Koaryu collects 0.5% only on successful processed transactions."
          actions={
            billingConnect ? (
              <StatusPill status={billingConnect.status} />
            ) : (
              <StatusPill status="not_connected" />
            )
          }
        >
          <div className="border-b border-border pb-4">
            <p className="text-base font-bold text-text-primary">
              {billingConnect?.charges_enabled ? "Stripe connected" : "Stripe not charging yet"}
            </p>
            <p className="mt-1 text-xs text-muted">
              Cash, checks, Zelle, Venmo, and outside processors cost nothing extra.
            </p>
          </div>
          <div className={`mt-4 ${billingOverviewMetricsClass}`}>
            <Fact label="Application fee">
              {billingConnect ? `${billingConnect.platform_fee_bps / 100}%` : "0.5%"} on successful
              charges
            </Fact>
            <Fact label="Chargeback liability">Studio account</Fact>
            <Fact
              label="UTC-month Stripe payment cohort"
              hint={
                // The page's boundary note already states this copy once.
                billingProviderCopy.boundary.includes(billingProviderCopy.connectPayments)
                  ? undefined
                  : billingProviderCopy.connectPayments
              }
            >
              {paymentCohortAvailable ? formatMoney(stripePaymentTotal) : "Unavailable"}
            </Fact>
            <Fact label="UTC-month external payment cohort">
              {paymentCohortAvailable ? formatMoney(externalPaymentTotal) : "Unavailable"}
            </Fact>
          </div>
          {billingConnect?.stripe_connected_account_id ? (
            <div className={`mt-4 ${styles.checklist}`}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-text-primary">
                  Stripe onboarding checklist
                </p>
                <ToneTag
                  tone={connectCompleteCount === connectRequirementItems.length ? "calm" : "warn"}
                >
                  {connectCompleteCount} / {connectRequirementItems.length} complete
                </ToneTag>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {connectRequirementItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-2 rounded-[10px] bg-surface px-3 py-2.5"
                  >
                    {item.complete ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-success" />
                    ) : (
                      <Clock3 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">{item.label}</p>
                      <p className="mt-0.5 text-[11px] leading-4 text-muted">
                        {item.complete ? "Received by Stripe" : item.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="md"
              disabled={!connectOnboardingEnabled || onboardingBlocked}
              title={connectOnboardingEnabled ? undefined : billingProviderCopy.connectOnboarding}
              isLoading={isLoadingAction("connect")}
              onClick={onConnectClick}
            >
              <Link2 className="h-3.5 w-3.5" />
              {isLoadingAction("connect") ? "Opening Stripe..." : connectActionLabel}
            </Button>
            <Button
              variant="secondary"
              size="md"
              disabled={!connectDashboardEnabled || dashboardBlocked}
              isLoading={isLoadingAction("dashboard")}
              title={
                !connectDashboardEnabled
                  ? billingProviderCopy.connectOnboarding
                  : canOpenStripeDashboard
                    ? "Open Stripe to review account status, requirements, payments, and payouts."
                    : "Available after Stripe Connect creates an account."
              }
              onClick={() =>
                void openBillingLink(
                  "/billing/connect/dashboard-link",
                  {
                    return_url: window.location.href,
                  },
                  "dashboard",
                )
              }
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              {isLoadingAction("dashboard") ? "Opening Stripe..." : "Stripe dashboard"}
            </Button>
            {hasStripeConnectedAccount ? (
              <span className="self-center text-xs text-muted">
                Reconnect is currently unavailable.
              </span>
            ) : null}
            {canResetConnect ? (
              <Button
                variant="danger"
                size="md"
                disabled={isActionLoading}
                onClick={() => setShowConnectResetConfirm(true)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset connection
              </Button>
            ) : null}
          </div>
        </BillingPanel>
      </div>

      <BillingPanel
        title="Message usage"
        description="Automation is included for every studio. Only email volume above the included monthly allowance is metered."
      >
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            {emailUsageProgress !== null ? (
              <div className={styles.meter}>
                <div style={{ width: `${emailUsageProgress}%` }} />
              </div>
            ) : null}
            <p className="mt-2 text-xs text-muted">
              {emailUsage
                ? `${emailUsage.sent} of ${emailUsage.included} emails used this month. Overage is $0.002 per email.`
                : "Unavailable"}
            </p>
          </div>
          <div className="md:text-right">
            <p className={`text-xl font-bold text-text-primary ${styles.factValue}`}>
              {emailUsage ? formatMoney(emailUsage.estimated_overage_cents) : "Unavailable"}
            </p>
            <p className="text-xs text-muted">Estimated overage</p>
          </div>
        </div>
      </BillingPanel>
      {showConnectResetConfirm ? (
        <ModalFrame
          role="alertdialog"
          ariaLabelledBy="connect-reset-title"
          ariaDescribedBy="connect-reset-description"
          panelClassName="w-[min(92vw,30rem)] rounded-[18px] bg-surface p-5"
          onBackdropClick={() => setShowConnectResetConfirm(false)}
        >
          <h2 id="connect-reset-title" className="text-lg font-bold text-text-primary">
            Reset Stripe connection?
          </h2>
          <p id="connect-reset-description" className="mt-2 text-sm leading-6 text-text-secondary">
            This clears Koaryu&apos;s current connected-account reference so an admin can start
            onboarding again. Existing provider history is not edited here.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={() => setShowConnectResetConfirm(false)}
            >
              Keep connection
            </Button>
            <Button
              type="button"
              variant="danger"
              size="md"
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
