"use client";

import { useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { api } from "@/lib/api";
import type { BillingActionRuntime } from "@/lib/billing-action-runtime";
import { buildExternalBillingPaymentPayload } from "@/lib/billing-page-form-model";
import {
  createExternalPaymentRequestKey,
  postExternalBillingPayment,
} from "@/lib/billing-report-actions-model";
import type { ExportJob } from "@/types";

type BillingReportActionsOptions = {
  canManageStudioBilling: boolean;
  runtime: BillingActionRuntime;
  setExportJobs: Dispatch<SetStateAction<ExportJob[]>>;
};

export function useBillingReportActions({
  canManageStudioBilling,
  runtime,
  setExportJobs,
}: BillingReportActionsOptions) {
  const [externalPayerId, setExternalPayerId] = useState("");
  const [externalAmount, setExternalAmount] = useState("");
  const [externalMethod, setExternalMethod] = useState("Zelle");
  const [externalNote, setExternalNote] = useState("");
  const externalPaymentRequestKeyRef = useRef<string | null>(null);

  function clearExternalPaymentRequestKey() {
    externalPaymentRequestKeyRef.current = null;
  }

  async function handleCreateExport(exportType: string) {
    if (!canManageStudioBilling) {
      runtime.setError("Only studio admins can queue billing exports.");
      return;
    }
    if (runtime.isPreviewMode) {
      runtime.setMessage("Demo export queued. Live exports run asynchronously.");
      return;
    }
    const action = `export:${exportType}`;
    if (!runtime.token || !runtime.claimAction(action)) {
      return;
    }
    try {
      const job = await api.post<ExportJob>("/billing/exports", { export_type: exportType, filters: {} }, runtime.token);
      setExportJobs((current) => [job, ...current]);
      runtime.setMessage("Export queued. Koaryu will attach a download when it is ready.");
    } catch (err) {
      runtime.setError(err instanceof Error ? err.message : "Export could not be queued.");
    } finally {
      runtime.releaseAction(action);
    }
  }

  async function handleRecordExternalPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runtime.setError("");
    runtime.setMessage("");
    if (!canManageStudioBilling) {
      runtime.setError("Only studio admins can record billing payments.");
      return;
    }
    const payloadResult = buildExternalBillingPaymentPayload({
      externalPayerId,
      externalAmount,
      externalMethod,
      externalNote,
    });
    if (!payloadResult.ok) {
      runtime.setError(payloadResult.error);
      return;
    }
    if (runtime.isPreviewMode) {
      runtime.setMessage("Demo external payment recorded locally.");
      clearExternalPaymentRequestKey();
      setExternalAmount("");
      setExternalNote("");
      return;
    }
    if (!runtime.token || !runtime.claimAction("record-external")) {
      return;
    }
    try {
      externalPaymentRequestKeyRef.current ??= createExternalPaymentRequestKey();
      await postExternalBillingPayment({
        payload: payloadResult.payload,
        post: api.post,
        requestKey: externalPaymentRequestKeyRef.current,
        token: runtime.token,
      });
      runtime.setMessage("External payment recorded.");
      clearExternalPaymentRequestKey();
      setExternalAmount("");
      setExternalNote("");
      await runtime.refreshBilling();
    } catch (err) {
      runtime.setError(err instanceof Error ? err.message : "External payment could not be recorded.");
    } finally {
      runtime.releaseAction("record-external");
    }
  }

  return {
    externalAmount,
    externalMethod,
    externalNote,
    externalPayerId,
    onCreateExport: handleCreateExport,
    onExternalAmountChange: (value: string) => {
      clearExternalPaymentRequestKey();
      setExternalAmount(value);
    },
    onExternalMethodChange: (value: string) => {
      clearExternalPaymentRequestKey();
      setExternalMethod(value);
    },
    onExternalNoteChange: (value: string) => {
      clearExternalPaymentRequestKey();
      setExternalNote(value);
    },
    onExternalPayerChange: (value: string) => {
      clearExternalPaymentRequestKey();
      setExternalPayerId(value);
    },
    onRecordExternalPayment: handleRecordExternalPayment,
  };
}
