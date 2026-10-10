"use client";

import type { BillingTab } from "@/lib/billing-page-state";
import { HorizonPanel } from "@/components/ui/horizon";
import {
  billingEnrollmentFormClass,
  billingExternalPaymentFormClass,
  billingLedgerLayout,
  billingOverviewMetricsClass,
  billingOverviewProvidersClass,
  billingPaymentGridColumns,
  billingPaymentHeaderClass,
  billingPaymentRowClass,
  billingReportMetricsClass,
} from "./billing-layout";

function PlaceholderLine({ className = "h-4 w-24" }: { className?: string }) {
  return <div className={`rounded-md bg-surface-raised ${className}`} />;
}

function PlaceholderForm({ className, fields }: { className: string; fields: number }) {
  return (
    <div className={className}>
      {Array.from({ length: fields }, (_, index) => (
        <div key={index} className="space-y-1.5">
          <PlaceholderLine className="h-5 w-20" />
          <PlaceholderLine className="h-11 w-full" />
        </div>
      ))}
    </div>
  );
}

function PlaceholderLedger({
  columns,
  header,
  row,
  title,
}: {
  columns: number;
  header: string;
  row: string;
  title: string;
}) {
  return (
    <HorizonPanel title={title} flush>
      <div className={header}>
        {Array.from({ length: columns }, (_, index) => (
          <PlaceholderLine key={index} className="h-4 w-16" />
        ))}
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className={row}>
          {Array.from({ length: columns }, (_, column) => (
            <div
              key={column}
              className={`space-y-2 ${column === 0 ? "col-span-2 lg:col-span-1 xl:col-span-1" : ""}`}
            >
              <PlaceholderLine />
              <PlaceholderLine className="h-3 w-16" />
            </div>
          ))}
        </div>
      ))}
    </HorizonPanel>
  );
}

const LEDGER_TITLES = {
  plans: "Tuition plans",
  families: "Families",
  enrollments: "Student billing",
  invoices: "Invoices",
} as const;

export function BillingContentPlaceholder({
  activeTab,
  canRefundPayments = false,
}: {
  activeTab: BillingTab;
  canRefundPayments?: boolean;
}) {
  return (
    <div
      className="koaryu-skeleton-reveal"
      role="status"
      aria-live="polite"
      aria-label="Loading billing"
      data-billing-placeholder={activeTab}
    >
      <span className="sr-only">Loading billing</span>
      <div aria-hidden="true" className="space-y-5">
        {activeTab === "overview" ? (
          <>
            <div className={billingOverviewProvidersClass}>
              {[
                {
                  title: "Koaryu Core",
                  description:
                    "One flat software subscription: no student caps, no staff caps, no feature gates.",
                },
                {
                  title: "Koaryu Payments",
                  description:
                    "Optional Stripe Connect add-on. Koaryu collects 0.5% only on successful processed transactions.",
                },
              ].map(({ title, description }) => (
                <HorizonPanel key={title} title={title} description={description}>
                  <div className="space-y-2 border-b border-border pb-4">
                    <PlaceholderLine className="h-9 w-32" />
                    <PlaceholderLine className="h-4 w-full" />
                  </div>
                  <div className={`mt-4 ${billingOverviewMetricsClass}`}>
                    {Array.from({ length: 4 }, (_, index) => (
                      <div key={index} className="space-y-2">
                        <PlaceholderLine className="h-3 w-24" />
                        <PlaceholderLine className="h-5 w-32" />
                      </div>
                    ))}
                  </div>
                  <PlaceholderLine className="mt-5 h-10 w-48" />
                </HorizonPanel>
              ))}
            </div>
            <HorizonPanel
              title="Message usage"
              description="Automation is included for every studio. Only email volume above the included monthly allowance is metered."
            >
              <PlaceholderLine className="h-2 w-full" />
              <PlaceholderLine className="mt-2 h-4 w-48" />
            </HorizonPanel>
          </>
        ) : activeTab === "reports" ? (
          <>
            <HorizonPanel title="This UTC month">
              <div className={billingReportMetricsClass}>
                {["UTC-month Stripe cohort", "UTC-month external cohort"].map((label) => (
                  <div key={label} className="space-y-2 rounded-[12px] bg-[var(--hz-tile)] p-4">
                    <p className="text-xs text-muted">{label}</p>
                    <PlaceholderLine className="h-8 w-24 bg-surface" />
                    <PlaceholderLine className="h-4 w-full bg-surface" />
                  </div>
                ))}
              </div>
            </HorizonPanel>
            <HorizonPanel title="Record external payment">
              <PlaceholderForm className={billingExternalPaymentFormClass} fields={5} />
            </HorizonPanel>
            <PlaceholderLedger
              title="Payments"
              columns={canRefundPayments ? 4 : 3}
              header={`${billingPaymentHeaderClass} ${billingPaymentGridColumns(canRefundPayments)}`}
              row={`${billingPaymentRowClass} ${billingPaymentGridColumns(canRefundPayments)}`}
            />
          </>
        ) : (
          <>
            {activeTab === "enrollments" ? (
              <HorizonPanel title="Attach external student billing">
                <PlaceholderForm className={billingEnrollmentFormClass} fields={8} />
              </HorizonPanel>
            ) : null}
            {activeTab === "invoices" ? (
              <HorizonPanel title="Failed payment queue">
                <PlaceholderLine className="h-12 w-full" />
              </HorizonPanel>
            ) : null}
            <PlaceholderLedger
              title={LEDGER_TITLES[activeTab]}
              {...billingLedgerLayout[activeTab]}
            />
          </>
        )}
      </div>
    </div>
  );
}
