"use client";

import type { BillingInvoiceAction } from "@/lib/billing-invoice-controller";
import type { BillingInvoice, BillingPayer } from "@/types";
import { BillingInvoicesTab } from "./billing-invoices-tab";

export function BillingInvoicesSection({
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
  onInvoiceAction: (invoiceId: string, action: BillingInvoiceAction) => void;
}) {
  return (
    <BillingInvoicesTab
      billingInvoices={billingInvoices}
      billingPayers={billingPayers}
      canReconcileInvoices={canReconcileInvoices}
      canUseWorkflow={canUseWorkflow}
      isActionLoading={isActionLoading}
      isLoadingAction={isLoadingAction}
      isPreviewMode={isPreviewMode}
      onInvoiceAction={onInvoiceAction}
    />
  );
}
