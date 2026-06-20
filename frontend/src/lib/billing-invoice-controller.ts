"use client";

import { useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { buildBillingInvoiceCreatePayload } from "@/lib/billing-page-form-model";
import type { BillingInvoice } from "@/types";

export type BillingInvoiceAction = "finalize" | "void" | "retry" | "reconcile";

type UseBillingInvoiceControllerOptions = {
  isPreviewMode: boolean;
  token: string | null;
  refreshBilling: () => Promise<void>;
  claimAction: (action: string) => boolean;
  releaseAction: (action: string) => void;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
};

function createInvoiceRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `invoice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useBillingInvoiceController({
  isPreviewMode,
  token,
  refreshBilling,
  claimAction,
  releaseAction,
  setError,
  setMessage,
}: UseBillingInvoiceControllerOptions) {
  const [invoicePayerId, setInvoicePayerId] = useState("");
  const [invoiceEnrollmentId, setInvoiceEnrollmentId] = useState("");
  const [invoiceStudentId, setInvoiceStudentId] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceDueDate, setInvoiceDueDate] = useState("");
  const [invoiceDescription, setInvoiceDescription] = useState("");
  const [invoiceSendHosted, setInvoiceSendHosted] = useState(true);
  const invoiceRequestKeyRef = useRef<string | null>(null);

  async function handleInvoiceAction(invoiceId: string, action: BillingInvoiceAction) {
    const actionKey = `invoice:${invoiceId}:${action}`;
    const successMessage = `Invoice ${action} requested.`;
    if (isPreviewMode) {
      setMessage(successMessage);
      return;
    }
    if (!token || !claimAction(actionKey)) return;
    try {
      await api.post<BillingInvoice>(`/billing/invoices/${invoiceId}/${action}`, {}, token);
      setMessage(successMessage);
      await refreshBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Billing action could not be completed.");
    } finally {
      releaseAction(actionKey);
    }
  }

  async function handleCreateInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    const payloadResult = buildBillingInvoiceCreatePayload({
      invoicePayerId,
      invoiceEnrollmentId,
      invoiceStudentId,
      invoiceAmount,
      invoiceDueDate,
      invoiceDescription,
      invoiceSendHosted,
    });
    if (!payloadResult.ok) {
      setError(payloadResult.error);
      return;
    }
    if (isPreviewMode) {
      setMessage(invoiceSendHosted ? "Demo hosted invoice drafted." : "Demo invoice drafted.");
      setInvoiceAmount("");
      setInvoiceDescription("");
      return;
    }
    if (!token) return;
    const action = "create-invoice";
    if (!claimAction(action)) return;
    try {
      invoiceRequestKeyRef.current ??= createInvoiceRequestKey();
      const requestKey = invoiceRequestKeyRef.current;
      await api.post<BillingInvoice>("/billing/invoices", payloadResult.payload, token, {
        headers: { "Idempotency-Key": requestKey },
      });
      setMessage(invoiceSendHosted ? "Hosted invoice created." : "Invoice drafted.");
      invoiceRequestKeyRef.current = null;
      setInvoiceAmount("");
      setInvoiceDescription("");
      await refreshBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invoice could not be created.");
    } finally {
      releaseAction(action);
    }
  }

  return {
    invoiceAmount,
    invoiceDescription,
    invoiceDueDate,
    invoiceEnrollmentId,
    invoicePayerId,
    invoiceSendHosted,
    invoiceStudentId,
    onCreateInvoice: handleCreateInvoice,
    onInvoiceAction: handleInvoiceAction,
    onInvoiceAmountChange: setInvoiceAmount,
    onInvoiceDescriptionChange: setInvoiceDescription,
    onInvoiceDraftChange: () => {
      invoiceRequestKeyRef.current = null;
    },
    onInvoiceDueDateChange: setInvoiceDueDate,
    onInvoiceEnrollmentChange: setInvoiceEnrollmentId,
    onInvoicePayerChange: setInvoicePayerId,
    onInvoiceSendHostedChange: setInvoiceSendHosted,
    onInvoiceStudentChange: setInvoiceStudentId,
  };
}

export type BillingInvoiceController = ReturnType<typeof useBillingInvoiceController>;
