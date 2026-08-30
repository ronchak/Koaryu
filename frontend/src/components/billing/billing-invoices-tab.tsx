"use client";

import { AlertTriangle, ArrowUpRight, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate, formatMoney } from "@/lib/billing-page-utils";
import type { BillingInvoice, BillingPayer } from "@/types";
import { SectionHeader, StatusPill } from "./billing-page-sections";

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
  const failedPayers = billingPayers.filter((payer) => payer.billing_status === "past_due" || payer.billing_status === "failed");

  return (
    <div className="space-y-5">
      <section className="rounded-[14px] border border-border bg-surface p-4">
        <SectionHeader
          icon={Receipt}
          title="Invoice workflows"
          description="Available actions come from the current server capability and invoice state. Koaryu preserves the original request key after an uncertain provider outcome."
        />
      </section>

      <section className="rounded-[14px] border border-border bg-surface p-4">
        <SectionHeader icon={AlertTriangle} title="Failed payment queue" description="Follow up with families without changing the student's training status." />
        {failedPayers.length === 0 ? (
          <p className="text-sm text-muted">No failed payer accounts right now.</p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-[10px] bg-surface-raised/30">
            {failedPayers.map((payer) => (
              <div key={payer.id} className="flex flex-col items-start gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-text-primary">{payer.display_name}</p>
                  <p className="break-words text-xs text-muted [overflow-wrap:anywhere]">{payer.email || "No email on file"}</p>
                </div>
                <div className="text-left sm:text-right">
                  <p className="font-medium text-danger">{formatMoney(payer.balance_cents)}</p>
                  <StatusPill status={payer.billing_status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-[14px] border border-border bg-surface">
        <div className="hidden grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted md:grid">
          <span>Invoice</span><span>Due</span><span>Gross due</span><span>Invoice receivable</span><span>Status</span><span>Actions</span>
        </div>
        {billingInvoices.length === 0 ? (
          <p className="p-4 text-sm text-muted">No invoices yet.</p>
        ) : billingInvoices.map((invoice) => {
          const canReconcile = canReconcileInvoices && !invoice.external && Boolean(invoice.stripe_invoice_id);
          const canFinalize = !invoice.external
            && invoice.status === "draft"
            && canUseWorkflow("invoice.finalize");
          const canRetry = !invoice.external
            && invoice.status === "open"
            && canUseWorkflow("invoice.retry");
          const canVoid = !invoice.external
            && (invoice.status === "draft" || invoice.status === "open")
            && canUseWorkflow("invoice.void");
          return (
            <div key={invoice.id} className="grid min-w-0 grid-cols-1 gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0 md:min-h-14 md:grid-cols-[1fr_auto_auto_auto_auto_auto] md:items-center md:gap-4 md:py-1.5">
              <div className="min-w-0">
                <p className="mb-1 text-xs font-medium text-muted md:hidden">Invoice</p>
                <p className="font-medium text-text-primary">{invoice.invoice_type.replace(/_/g, " ")}</p>
                <p className="break-words text-xs text-muted [overflow-wrap:anywhere]">{invoice.external ? "External payment record" : invoice.number || "Connected invoice"}</p>
                {invoice.hosted_invoice_url && !isPreviewMode ? (
                  <a className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline" href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">
                    Hosted invoice <ArrowUpRight className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
              <div>
                <p className="text-xs font-medium text-muted md:hidden">Due</p>
                <p className="text-text-secondary">{formatDate(invoice.due_date)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted md:hidden">Gross due</p>
                <p className="font-medium text-text-primary">{formatMoney(invoice.amount_due_cents, invoice.currency)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted md:hidden">Invoice receivable</p>
                <p className="font-medium text-text-primary">{formatMoney(invoice.invoice_receivable_amount_cents, invoice.currency)}</p>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted md:hidden">Status</p>
                <StatusPill status={invoice.status} />
              </div>
              <div className="flex flex-wrap justify-start gap-2 md:justify-end">
                {invoice.hosted_invoice_url && !isPreviewMode ? (
                  <Button asChild variant="secondary" size="sm">
                    <a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer"><ArrowUpRight className="h-3.5 w-3.5" />Open</a>
                  </Button>
                ) : null}
                {canReconcile ? (
                  <Button variant="secondary" size="sm" disabled={isActionLoading} isLoading={isLoadingAction(`invoice:${invoice.id}:reconcile`)} onClick={() => onInvoiceAction(invoice.id, "reconcile")}>
                    {isLoadingAction(`invoice:${invoice.id}:reconcile`) ? "Reconciling..." : "Reconcile"}
                  </Button>
                ) : null}
                {canFinalize ? (
                  <Button size="sm" disabled={isActionLoading} isLoading={isLoadingAction(`invoice:${invoice.id}:finalize`)} onClick={() => onInvoiceAction(invoice.id, "finalize")}>
                    {isLoadingAction(`invoice:${invoice.id}:finalize`) ? "Finalizing..." : "Finalize"}
                  </Button>
                ) : null}
                {canRetry ? (
                  <Button size="sm" disabled={isActionLoading} isLoading={isLoadingAction(`invoice:${invoice.id}:retry`)} onClick={() => onInvoiceAction(invoice.id, "retry")}>
                    {isLoadingAction(`invoice:${invoice.id}:retry`) ? "Retrying..." : "Retry payment"}
                  </Button>
                ) : null}
                {canVoid ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isActionLoading}
                    isLoading={isLoadingAction(`invoice:${invoice.id}:void`)}
                    onClick={() => {
                      if (window.confirm("Void this invoice? The invoice will no longer be collectible and this action cannot be undone.")) {
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
        })}
      </section>
    </div>
  );
}
