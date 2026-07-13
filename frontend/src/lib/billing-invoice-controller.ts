"use client";

import { api } from "@/lib/api";
import type { BillingInvoice } from "@/types";

export type BillingInvoiceAction = "finalize" | "void" | "retry" | "reconcile";

type UseBillingInvoiceControllerOptions = {
  canReconcileInvoices: boolean;
  isPreviewMode: boolean;
  token: string | null;
  refreshBilling: () => Promise<void>;
  claimAction: (action: string) => boolean;
  releaseAction: (action: string) => void;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
};

export function useBillingInvoiceController({
  canReconcileInvoices,
  isPreviewMode,
  token,
  refreshBilling,
  claimAction,
  releaseAction,
  setError,
  setMessage,
}: UseBillingInvoiceControllerOptions) {
  async function handleInvoiceAction(invoiceId: string, action: BillingInvoiceAction) {
    if (action !== "reconcile") {
      setError("Provider invoice mutations are not enabled for the Friendly Pilot release.");
      return;
    }
    if (!canReconcileInvoices) {
      setError("Only studio admins and front desk staff can reconcile invoices.");
      return;
    }
    const actionKey = `invoice:${invoiceId}:${action}`;
    const successMessage = `Invoice ${action} requested.`;
    if (isPreviewMode) {
      setMessage(successMessage);
      return;
    }
    if (!token || !claimAction(actionKey)) return;
    try {
      await api.post<BillingInvoice>(`/billing/invoices/${invoiceId}/reconcile`, {}, token);
      setMessage(successMessage);
      await refreshBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Billing action could not be completed.");
    } finally {
      releaseAction(actionKey);
    }
  }

  return {
    onInvoiceAction: handleInvoiceAction,
  };
}

export type BillingInvoiceController = ReturnType<typeof useBillingInvoiceController>;
