"use client";

import type { FormEvent } from "react";
import { Banknote, Download, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, formatMoney } from "@/lib/billing-page-utils";
import type { BillingPayer, BillingPayment, ExportJob } from "@/types";
import { Metric, SectionHeader, StatusPill } from "./billing-page-sections";

export function BillingReportsTab({
  billingPayers,
  billingPayments,
  canManageRoutineBilling,
  externalAmount,
  externalMethod,
  externalNote,
  externalPayerId,
  externalPaymentTotal,
  exportJobs,
  isActionLoading,
  isLoadingAction,
  koaryuFeeBasis,
  onExternalAmountChange,
  onExternalMethodChange,
  onExternalNoteChange,
  onExternalPayerChange,
  onRecordExternalPayment,
  paymentCohortAvailable,
  stripePaymentTotal,
}: {
  billingPayers: BillingPayer[];
  billingPayments: BillingPayment[];
  canManageRoutineBilling: boolean;
  externalAmount: string;
  externalMethod: string;
  externalNote: string;
  externalPayerId: string;
  externalPaymentTotal: number;
  exportJobs: ExportJob[];
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  koaryuFeeBasis: number;
  onExternalAmountChange: (value: string) => void;
  onExternalMethodChange: (value: string) => void;
  onExternalNoteChange: (value: string) => void;
  onExternalPayerChange: (value: string) => void;
  onRecordExternalPayment: (event: FormEvent<HTMLFormElement>) => void;
  paymentCohortAvailable: boolean;
  stripePaymentTotal: number;
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="UTC-month Stripe cohort" value={paymentCohortAvailable ? formatMoney(stripePaymentTotal) : "Unavailable"} hint="Payments processed this UTC month, net of cumulative refunds" />
        <Metric label="UTC-month external cohort" value={paymentCohortAvailable ? formatMoney(externalPaymentTotal) : "Unavailable"} hint="External payments processed this UTC month" />
        <Metric label="UTC-month fee cohort" value={paymentCohortAvailable ? formatMoney(koaryuFeeBasis) : "Unavailable"} hint="0.5% of the Stripe payment cohort net of cumulative refunds" />
      </div>
      <p className="text-xs text-muted">
        These figures are the current UTC month payment cohort net of cumulative refunds recorded on those payments.
        Refund event dates are unavailable here, so this is not cash movement or true period-net revenue.
      </p>

      <section className="border border-border bg-surface rounded-[6px] p-5">
        <SectionHeader icon={Download} title="Billing exports are read-only" description="New CSV exports are not enabled for Friendly Pilot. Existing job history remains visible for operational context." />
        {exportJobs.length ? (
          <div className="mt-4 divide-y divide-border border border-border rounded-[6px]">
            {exportJobs.map((job) => (
              <div key={job.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <div>
                  <p className="font-medium text-text-primary">{job.export_type.replace(/_/g, " ")}</p>
                  <p className="text-xs text-muted">Queued {formatDate(job.created_at)}</p>
                </div>
                <StatusPill status={job.status} />
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted">No historical export jobs.</p>
        )}
      </section>

      <section className="border border-border bg-surface rounded-[6px] p-5">
        <SectionHeader icon={Banknote} title="Record external payment" description="Track cash, check, Zelle, Venmo, or outside-processor payments without charging a Koaryu platform fee." />
        <form onSubmit={onRecordExternalPayment} className="grid gap-3 md:grid-cols-[1fr_0.6fr_0.7fr_1fr_auto] md:items-end">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-text-secondary font-medium" htmlFor="external-payer">Payer</label>
            <select
              id="external-payer"
              value={externalPayerId}
              onChange={(event) => onExternalPayerChange(event.target.value)}
              disabled={!canManageRoutineBilling || billingPayers.length === 0}
              className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">Choose payer</option>
              {billingPayers.map((payer) => (
                <option key={payer.id} value={payer.id}>{payer.display_name}</option>
              ))}
            </select>
          </div>
          <Input label="Amount" value={externalAmount} onChange={(event) => onExternalAmountChange(event.target.value)} placeholder="129" inputMode="decimal" disabled={!canManageRoutineBilling} />
          <Input label="Method" value={externalMethod} onChange={(event) => onExternalMethodChange(event.target.value)} placeholder="Zelle" disabled={!canManageRoutineBilling} />
          <Input label="Note" value={externalNote} onChange={(event) => onExternalNoteChange(event.target.value)} placeholder="Optional" disabled={!canManageRoutineBilling} />
          <Button type="submit" size="sm" disabled={!canManageRoutineBilling || isActionLoading || billingPayers.length === 0} isLoading={isLoadingAction("record-external")}>
            <Plus className="h-3.5 w-3.5" />
            {isLoadingAction("record-external") ? "Recording..." : "Record"}
          </Button>
        </form>
      </section>

      <section className="border border-border bg-surface rounded-[6px]">
        <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted">
          <span>Payment</span>
          <span>Amount</span>
          <span>Status</span>
        </div>
        {billingPayments.length === 0 ? (
          <p className="p-4 text-sm text-muted">No payments recorded yet.</p>
        ) : billingPayments.map((payment) => (
          <div key={payment.id} className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-border px-4 py-4 text-sm last:border-b-0">
            <div>
              <p className="font-medium text-text-primary">{payment.external_method || payment.payment_method_type || "Payment"}</p>
              <p className="text-xs text-muted">{payment.note || formatDate(payment.processed_at)}</p>
            </div>
            <p className="font-medium text-text-primary">{formatMoney(payment.amount_cents, payment.currency)}</p>
            <StatusPill status={payment.status} />
          </div>
        ))}
      </section>
    </div>
  );
}
