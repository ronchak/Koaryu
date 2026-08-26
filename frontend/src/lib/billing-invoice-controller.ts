"use client";

import { useRef } from "react";
import { api } from "@/lib/api";
import {
  buildInvoiceOperationRequest,
  clearPersistedInvoiceOperationRequestKey,
  resolvePersistedInvoiceOperationRequestKey,
  type InvoiceOperationIdentity,
} from "@/lib/billing-invoice-action-model";
import type { BillingInvoice } from "@/types";

export type BillingInvoiceAction = "finalize" | "void" | "retry" | "reconcile";

type UseBillingInvoiceControllerOptions = {
  canReconcileInvoices: boolean;
  canUseWorkflow: (workflowId: string) => boolean;
  isPreviewMode: boolean;
  operationIdentity: InvoiceOperationIdentity | null;
  token: string | null;
  refreshBilling: () => Promise<void>;
  claimAction: (action: string) => boolean;
  releaseAction: (action: string) => void;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
};

export function useBillingInvoiceController({
  canReconcileInvoices,
  canUseWorkflow,
  isPreviewMode,
  operationIdentity,
  token,
  refreshBilling,
  claimAction,
  releaseAction,
  setError,
  setMessage,
}: UseBillingInvoiceControllerOptions) {
  const operationKeysRef = useRef(new Map<string, string>());

  async function handleInvoiceAction(
    invoiceId: string,
    action: BillingInvoiceAction,
    options: { startNewRequest?: boolean } = {},
  ) {
    const workflowId = action === "reconcile" ? null : `invoice.${action}`;
    if (workflowId && !canUseWorkflow(workflowId)) {
      setError("This invoice workflow is not available for the current studio and role.");
      return;
    }
    if (action === "reconcile" && !canReconcileInvoices) {
      setError("Only studio admins and front desk staff can reconcile invoices.");
      return;
    }
    const actionKey = `invoice:${invoiceId}:${action}`;
    const successMessage = `Invoice ${action} requested.`;
    if (isPreviewMode) {
      setMessage(successMessage);
      return;
    }
    const requestKey = action !== "reconcile"
      ? resolvePersistedInvoiceOperationRequestKey({
          identity: operationIdentity,
          keysByTarget: operationKeysRef.current,
          operation: `invoice.${action}`,
          startNewRequest: options.startNewRequest,
          targetId: invoiceId,
        })
      : null;
    if (!token || !claimAction(actionKey)) return;
    try {
      const path = `/billing/invoices/${invoiceId}/${action}`;
      await api.post<BillingInvoice>(
        path,
        {},
        token,
        requestKey ? buildInvoiceOperationRequest(requestKey) : undefined,
      );
      if (action !== "reconcile") {
        clearPersistedInvoiceOperationRequestKey({
          identity: operationIdentity,
          keysByTarget: operationKeysRef.current,
          operation: `invoice.${action}`,
          targetId: invoiceId,
        });
      }
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
