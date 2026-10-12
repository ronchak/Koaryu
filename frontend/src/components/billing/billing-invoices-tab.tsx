"use client";

import { AlertTriangle, ArrowUpRight, CheckCircle2, Mail } from "lucide-react";
import { billingLedgerLayout } from "./billing-layout";
import { Button } from "@/components/ui/button";
import { CalmState, ToneChip, ToneTag } from "@/components/ui/horizon";
import {
  billingInvoiceReference,
  billingPayerLabel,
  billingPayerNameById,
  invoiceVoidConfirmation,
} from "@/lib/billing-page-model";
import { formatBillingCalendarDate, formatMoney } from "@/lib/billing-page-utils";
import type { BillingInvoice, BillingPayer } from "@/types";
import { BillingEmpty, BillingPanel, PayerBalances, StatusPill } from "./billing-page-sections";
import styles from "./billing.module.css";

export function BillingInvoicesTab({
  billingInvoices,
  billingPayers,
  canReconcileInvoices,
  canUseWorkflow,
  isActionLoading,
  isLoadingAction,
  isPreviewMode,
  onInvoiceAction,
}: {
  billingInvoices: BillingInvoice[];
  billingPayers: BillingPayer[];
  canReconcileInvoices: boolean;
  canUseWorkflow: (workflowId: string) => boolean;
  isActionLoading: boolean;
  isLoadingAction: (action: string) => boolean;
  isPreviewMode: boolean;
  onInvoiceAction: (invoiceId: string, action: "finalize" | "void" | "retry" | "reconcile") => void;
}) {
  const failedPayers = billingPayers.filter(
    (payer) => payer.billing_status === "past_due" || payer.billing_status === "failed",
  );
  const payerNameById = billingPayerNameById(billingPayers);

  return (
    <div className="space-y-5">
      <BillingPanel
        title="Failed payment queue"
        description="Follow up with families without changing the student's training status."
        actions={
          failedPayers.length > 0 ? (
            <ToneTag tone="alert">
              {failedPayers.length === 1 ? "1 family" : `${failedPayers.length} families`} to
              follow up
            </ToneTag>
          ) : null
        }
        flush
      >
        {failedPayers.length === 0 ? (
          <div className={styles.inset}>
            <CalmState
              icon={<CheckCircle2 />}
              title="No failed payer accounts right now."
              detail="Failed or past-due tuition shows up here with its balance."
            />
          </div>
        ) : (
          <ul className={styles.queue}>
            {failedPayers.map((payer) => (
              <li key={payer.id} className={styles.queueRow}>
                <div className={styles.queueWho}>
                  <ToneChip tone="alert">
                    <AlertTriangle />
                  </ToneChip>
                  <div className={styles.queueText}>
                    <strong>{payer.display_name}</strong>
                    <span>{payer.email || "No email on file"}</span>
                    <span>
                      <StatusPill status={payer.billing_status} />
                    </span>
                  </div>
                </div>
                <div className={styles.queueAmounts}>
                  <PayerBalances
                    balanceCents={payer.balance_cents}
                    overdueCents={payer.overdue_balance_cents}
                    uncollectibleCents={payer.uncollectible_balance_cents}
                    tone="alert"
                  />
                </div>
                {payer.email ? (
                  <div className={styles.queueAction}>
                    <Button asChild variant="secondary" size="md">
                      <a href={`mailto:${payer.email}`}>
                        <Mail className="h-3.5 w-3.5" />
                        Email family
                      </a>
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </BillingPanel>

      <BillingPanel
        title="Invoices"
        description="Available actions come from the current server capability and invoice state. Koaryu preserves the original request key after an uncertain provider outcome."
        flush
      >
        <div className={billingLedgerLayout.invoices.header}>
          <span>Invoice</span>
          <span>Due</span>
          <span className="text-right">Gross due</span>
          <span className="text-right">Invoice receivable</span>
          <span>Status</span>
          <span className="sr-only">Actions</span>
        </div>
        {billingInvoices.length === 0 ? (
          <BillingEmpty title="No invoices yet." />
        ) : (
          billingInvoices.map((invoice) => {
            const canReconcile =
              canReconcileInvoices && !invoice.external && Boolean(invoice.stripe_invoice_id);
            const canFinalize =
              !invoice.external &&
              invoice.status === "draft" &&
              canUseWorkflow("invoice.finalize");
            const canRetry =
              !invoice.external && invoice.status === "open" && canUseWorkflow("invoice.retry");
            const canVoid =
              !invoice.external &&
              (invoice.status === "draft" || invoice.status === "open") &&
              canUseWorkflow("invoice.void");
            const owes = invoice.invoice_receivable_amount_cents > 0;
            return (
              <div key={invoice.id} className={billingLedgerLayout.invoices.row}>
                <div className="col-span-2 min-w-0 xl:col-span-1">
                  <p className="font-semibold text-text-primary">
                    {billingPayerLabel(invoice.payer_id, payerNameById)}
                  </p>
                  <p className="mt-0.5 break-words text-xs text-muted [overflow-wrap:anywhere]">
                    <span className="capitalize">{invoice.invoice_type.replace(/_/g, " ")}</span>
                    {" · "}
                    {invoice.external
                      ? `External payment record · ${billingInvoiceReference(invoice)}`
                      : billingInvoiceReference(invoice)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted xl:hidden">Due</p>
                  <p className="tabular-nums text-text-secondary">
                    {formatBillingCalendarDate(invoice.due_date)}
                  </p>
                </div>
                <div className="xl:text-right">
                  <p className="text-xs text-muted xl:hidden">Gross due</p>
                  <p className="tabular-nums text-text-secondary">
                    {formatMoney(invoice.amount_due_cents, invoice.currency)}
                  </p>
                </div>
                <div className="xl:text-right">
                  <p className="text-xs text-muted xl:hidden">Invoice receivable</p>
                  <p
                    className={`text-base font-bold tabular-nums ${owes ? "text-text-primary" : "text-muted"}`}
                  >
                    {formatMoney(invoice.invoice_receivable_amount_cents, invoice.currency)}
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-xs text-muted xl:hidden">Status</p>
                  <StatusPill status={invoice.status} />
                </div>
                <div className="col-span-2 flex flex-wrap justify-start gap-2 xl:col-span-1 xl:justify-end">
                  {canRetry ? (
                    <Button
                      size="md"
                      disabled={isActionLoading}
                      isLoading={isLoadingAction(`invoice:${invoice.id}:retry`)}
                      onClick={() => onInvoiceAction(invoice.id, "retry")}
                    >
                      {isLoadingAction(`invoice:${invoice.id}:retry`) ? "Retrying..." : "Retry payment"}
                    </Button>
                  ) : null}
                  {canFinalize ? (
                    <Button
                      size="md"
                      disabled={isActionLoading}
                      isLoading={isLoadingAction(`invoice:${invoice.id}:finalize`)}
                      onClick={() => onInvoiceAction(invoice.id, "finalize")}
                    >
                      {isLoadingAction(`invoice:${invoice.id}:finalize`) ? "Finalizing..." : "Finalize"}
                    </Button>
                  ) : null}
                  {invoice.hosted_invoice_url && !isPreviewMode ? (
                    <Button asChild variant="secondary" size="md">
                      <a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">
                        <ArrowUpRight className="h-3.5 w-3.5" />
                        Open
                      </a>
                    </Button>
                  ) : null}
                  {canReconcile ? (
                    <Button
                      variant="secondary"
                      size="md"
                      disabled={isActionLoading}
                      isLoading={isLoadingAction(`invoice:${invoice.id}:reconcile`)}
                      onClick={() => onInvoiceAction(invoice.id, "reconcile")}
                    >
                      {isLoadingAction(`invoice:${invoice.id}:reconcile`)
                        ? "Reconciling..."
                        : "Reconcile"}
                    </Button>
                  ) : null}
                  {canVoid ? (
                    <Button
                      variant="ghost"
                      size="md"
                      disabled={isActionLoading}
                      isLoading={isLoadingAction(`invoice:${invoice.id}:void`)}
                      onClick={() => {
                        if (window.confirm(invoiceVoidConfirmation(invoice, payerNameById))) {
                          onInvoiceAction(invoice.id, "void");
                        }
                      }}
                    >
                      {isLoadingAction(`invoice:${invoice.id}:void`) ? "Voiding..." : "Void"}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </BillingPanel>
    </div>
  );
}
