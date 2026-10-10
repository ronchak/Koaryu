"use client";

import { Banknote, CreditCard, Mail } from "lucide-react";
import type { BillingTab } from "@/lib/billing-page-state";
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
import { SectionHeader } from "./billing-page-sections";

function PlaceholderLine({ className = "h-4 w-24" }: { className?: string }) {
  return <div className={`rounded bg-surface-raised ${className}`} />;
}

function PlaceholderForm({ className, fields }: { className: string; fields: number }) {
  return (
    <div className={className}>
      {Array.from({ length: fields }, (_, index) => (
        <div key={index} className="space-y-1.5">
          <PlaceholderLine className="h-5 w-20" />
          <PlaceholderLine className="h-10 w-full" />
        </div>
      ))}
    </div>
  );
}

function PlaceholderLedger({
  columns,
  header,
  row,
}: {
  columns: number;
  header: string;
  row: string;
}) {
  return (
    <section className="overflow-hidden rounded-[14px] border border-border bg-surface">
      <div className={header}>
        {Array.from({ length: columns }, (_, index) => (
          <PlaceholderLine key={index} />
        ))}
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className={row}>
          {Array.from({ length: columns }, (_, column) => (
            <div key={column} className="space-y-2 py-2">
              <PlaceholderLine />
              <PlaceholderLine className="h-3 w-16" />
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

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
            <section className="overflow-hidden bg-surface">
              <div className={billingOverviewMetricsClass}>
                {[
                  "Needs attention",
                  "Open receivables",
                  "Collected this UTC month",
                  "Student coverage",
                ].map((label) => (
                  <div key={label} className="rounded-[10px] bg-surface-raised/50 p-4">
                    <p className="text-xs font-medium text-muted">{label}</p>
                    <PlaceholderLine className="mt-2 h-8 w-24" />
                    <PlaceholderLine className="mt-1 h-5 w-full" />
                  </div>
                ))}
              </div>
              <div className="border-t border-border px-4 py-2">
                <PlaceholderLine className="h-4 w-3/4" />
              </div>
            </section>
            <div className={billingOverviewProvidersClass}>
              {[
                {
                  title: "Koaryu Core",
                  icon: CreditCard,
                  description:
                    "One flat software subscription: no student caps, no staff caps, no feature gates.",
                },
                {
                  title: "Koaryu Payments",
                  icon: Banknote,
                  description:
                    "Optional Stripe Connect add-on. Koaryu collects 0.5% only on successful processed transactions.",
                },
              ].map(({ title, icon, description }) => (
                <section key={title} className="rounded-[14px] border border-border bg-surface p-4">
                  <SectionHeader icon={icon} title={title} description={description} />
                  <div className="space-y-2 border-b border-border pb-4">
                    <PlaceholderLine className="h-8 w-32" />
                    <PlaceholderLine className="h-4 w-full" />
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {Array.from({ length: 4 }, (_, index) => (
                      <div key={index} className="space-y-2">
                        <PlaceholderLine className="h-3 w-24" />
                        <PlaceholderLine className="h-5 w-32" />
                      </div>
                    ))}
                  </div>
                  <PlaceholderLine className="mt-4 h-8 w-48" />
                </section>
              ))}
            </div>
            <section className="rounded-[14px] border border-border bg-surface p-4">
              <SectionHeader
                icon={Mail}
                title="Message usage"
                description="Automation is included for every studio. Only email volume above the included monthly allowance is metered."
              />
              <PlaceholderLine className="h-2 w-full" />
              <PlaceholderLine className="mt-2 h-4 w-48" />
            </section>
          </>
        ) : activeTab === "reports" ? (
          <>
            <div className={billingReportMetricsClass}>
              {["UTC-month Stripe cohort", "UTC-month external cohort"].map((label) => (
                <div key={label} className="rounded-[14px] border border-border bg-surface p-4">
                  <p className="text-xs text-muted">{label}</p>
                  <PlaceholderLine className="mt-1 h-7 w-24" />
                  <PlaceholderLine className="mt-1 h-4 w-full" />
                </div>
              ))}
            </div>
            <PlaceholderLine className="h-8 w-full" />
            <section className="rounded-[14px] border border-border bg-surface p-4">
              <SectionHeader icon={CreditCard} title="Record external payment" />
              <PlaceholderForm className={billingExternalPaymentFormClass} fields={5} />
            </section>
            <PlaceholderLedger
              columns={canRefundPayments ? 4 : 3}
              header={`${billingPaymentHeaderClass} ${billingPaymentGridColumns(canRefundPayments)}`}
              row={`${billingPaymentRowClass} ${billingPaymentGridColumns(canRefundPayments)}`}
            />
          </>
        ) : (
          <>
            <section className="rounded-[14px] border border-border bg-surface p-4">
              <PlaceholderLine className="mb-4 h-5 w-48" />
              {activeTab === "enrollments" ? (
                <PlaceholderForm className={billingEnrollmentFormClass} fields={8} />
              ) : (
                <PlaceholderLine className="h-4 w-full" />
              )}
            </section>
            {activeTab === "invoices" ? (
              <section className="rounded-[14px] border border-border bg-surface p-4">
                <PlaceholderLine className="mb-4 h-5 w-48" />
                <PlaceholderLine className="h-5 w-full" />
              </section>
            ) : null}
            <PlaceholderLedger {...billingLedgerLayout[activeTab]} />
          </>
        )}
      </div>
    </div>
  );
}
