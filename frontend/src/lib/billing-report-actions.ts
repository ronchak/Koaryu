"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { api } from "@/lib/api";
import type { BillingActionRuntime } from "@/lib/billing-action-runtime";
import { buildExternalBillingPaymentPayload } from "@/lib/billing-page-form-model";
import {
  browserExternalPaymentStorage,
  createExternalPaymentRequestKey,
  isMatchingExternalPaymentResponse,
  postExternalBillingPayment,
  readExternalPaymentAttempt,
  retainExternalPaymentAttempt,
  retireExternalPaymentAttempt,
  sameExternalPaymentAttempt,
  type ExternalPaymentAttempt,
  type ExternalPaymentIdentity,
} from "@/lib/billing-report-actions-model";
import type { ExportJob } from "@/types";

type BillingReportActionsOptions = {
  canManageRoutineBilling: boolean;
  identity: ExternalPaymentIdentity | null;
  identityKey: string | null;
  runtime: BillingActionRuntime;
  setExportJobs: Dispatch<SetStateAction<ExportJob[]>>;
};
type Draft = { externalPayerId: string; externalAmount: string; externalMethod: string; externalNote: string };
type State = { scope: string | null; ready: boolean; error: string; attempt: ExternalPaymentAttempt | null; form: Draft };
const emptyForm = (): Draft => ({ externalPayerId: "", externalAmount: "", externalMethod: "Zelle", externalNote: "" });
const emptyState = (scope: string | null): State => ({ scope, ready: false, error: "", attempt: null, form: emptyForm() });
function attemptForm(attempt: ExternalPaymentAttempt): Draft {
  return {
    externalPayerId: attempt.payload.payer_id!,
    externalAmount: (attempt.payload.amount_cents / 100).toFixed(2),
    externalMethod: attempt.payload.external_method,
    externalNote: attempt.payload.note ?? "",
  };
}

export function useBillingReportActions({
  canManageRoutineBilling, identity, identityKey, runtime, setExportJobs,
}: BillingReportActionsOptions) {
  const scope = runtime.isPreviewMode ? `preview:${identityKey ?? "anonymous"}`
    : canManageRoutineBilling && runtime.token && identity && identityKey
      && runtime.canUseWorkflow("payment.external.record") ? identityKey : null;
  const storageReady = useSyncExternalStore(() => () => {}, () => true, () => false);
  const resolvedScope = runtime.isPreviewMode || storageReady ? scope : null;
  const [state, setState] = useState<State>(() => emptyState(null));
  if (state.scope !== resolvedScope) {
    const next = emptyState(resolvedScope);
    if (resolvedScope && runtime.isPreviewMode) {
      next.ready = true;
    } else if (resolvedScope && identity) {
      try {
        next.attempt = readExternalPaymentAttempt(identity, browserExternalPaymentStorage());
        if (next.attempt) next.form = attemptForm(next.attempt);
        next.ready = true;
      } catch (error) {
        next.error = error instanceof Error ? error.message : "Payment recovery is unavailable.";
      }
    }
    setState(next);
  }
  const scopeRef = useRef<string | null>(null);
  const operationRef = useRef<{ release: () => void } | null>(null);
  const noticeScopeRef = useRef<string | null>(null);
  const contextRef = useRef({ identity, runtime });
  // Keep current callbacks without restarting ownership on ordinary rerenders.
  useLayoutEffect(() => { contextRef.current = { identity, runtime }; });
  useLayoutEffect(() => {
    const context = contextRef.current;
    scopeRef.current = scope;
    if (noticeScopeRef.current !== null && noticeScopeRef.current !== scope) {
      context.runtime.setError("");
      context.runtime.setMessage("");
      noticeScopeRef.current = null;
    }
    return () => {
      scopeRef.current = null;
      const operation = operationRef.current;
      operationRef.current = null;
      operation?.release();
    };
  }, [scope]);

  const active = state.scope === scope ? state : emptyState(scope);
  const formLocked = !active.ready || Boolean(active.attempt) || runtime.isLoadingAction("record-external");
  function change(field: keyof Draft, value: string) {
    if (!canManageRoutineBilling || !scope || scopeRef.current !== scope || formLocked || operationRef.current) return;
    setState(previous => previous.scope === scope && !previous.attempt
      ? { ...previous, form: { ...previous.form, [field]: value } } : previous);
  }
  function errorMessage(message: string) {
    noticeScopeRef.current = scope;
    runtime.setError(message);
  }
  function successMessage(message: string) {
    noticeScopeRef.current = scope;
    runtime.setMessage(message);
  }

  async function handleCreateExport(exportType: string) {
    void exportType;
    void setExportJobs;
    runtime.setError("New billing exports are currently unavailable.");
  }

  async function handleRecordExternalPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (scopeRef.current !== scope) return;
    if (!canManageRoutineBilling) {
      errorMessage("Only studio admins and front desk staff can record external payments.");
      return;
    }
    if (!scope || scopeRef.current !== scope || !active.ready || operationRef.current) return;
    const payloadResult = buildExternalBillingPaymentPayload(active.form);
    if (!active.attempt && !payloadResult.ok) {
      errorMessage(payloadResult.error);
      return;
    }
    if (runtime.isPreviewMode) {
      runtime.setError("");
      successMessage("Demo external payment recorded locally.");
      setState(previous => ({ ...previous, form: { ...previous.form, externalAmount: "", externalNote: "" } }));
      return;
    }
    if (!identity || !runtime.token || !runtime.canUseWorkflow("payment.external.record")
        || !runtime.claimAction("record-external")) return;
    const operation = { release: () => runtime.releaseAction("record-external") };
    operationRef.current = operation;
    const current = () => scopeRef.current === scope && operationRef.current === operation;
    const storage = browserExternalPaymentStorage();
    let posted = false;
    let accepted = false;
    try {
      const saved = readExternalPaymentAttempt(identity, storage);
      if (saved && !active.attempt) {
        setState({ scope, ready: true, error: "", attempt: saved, form: attemptForm(saved) });
        successMessage("Recover the saved payment request before entering another payment.");
        return;
      }
      if (saved && active.attempt && !sameExternalPaymentAttempt(saved, active.attempt)) {
        throw new Error("The saved payment request changed. Reload this page before continuing.");
      }
      let attempt = active.attempt;
      if (!attempt) {
        if (!payloadResult.ok) throw new Error(payloadResult.error);
        attempt = { version: 1, requestKey: createExternalPaymentRequestKey(), payload: payloadResult.payload };
      }
      retainExternalPaymentAttempt(identity, attempt, storage);
      setState({ scope, ready: true, error: "", attempt, form: attemptForm(attempt) });
      posted = true;
      const result = await postExternalBillingPayment({
        payload: attempt.payload, post: api.post, requestKey: attempt.requestKey, token: runtime.token,
      });
      if (!current()) return;
      if (!isMatchingExternalPaymentResponse(result, identity, attempt)) {
        throw new Error("The payment result could not be verified. Retry the saved original request.");
      }
      accepted = true;
      successMessage("External payment recorded.");
      retireExternalPaymentAttempt(identity, attempt, storage);
      setState({ scope, ready: true, error: "", attempt: null,
        form: { ...attemptForm(attempt), externalAmount: "", externalNote: "" } });
      // The confirmed write stands even when the loader reports a read error.
      await runtime.refreshBilling();
    } catch (error) {
      if (!current()) return;
      const detail = error instanceof Error ? error.message : "External payment could not be confirmed.";
      if (!posted) setState(previous => previous.scope === scope ? { ...previous, ready: false, error: detail } : previous);
      errorMessage(accepted ? `The payment was recorded, but completion needs attention. ${detail}` : detail);
    } finally {
      if (current()) {
        operationRef.current = null;
        operation.release();
      }
    }
  }

  return {
    ...active.form,
    externalPaymentReady: active.ready && scope !== null,
    externalPaymentFormLocked: formLocked,
    externalPaymentRecoveryMessage: active.error || (active.attempt
      ? "This payment request is saved. Retry the original request before entering another payment." : ""),
    externalPaymentIsRetry: active.attempt !== null,
    onCreateExport: handleCreateExport,
    onExternalAmountChange: (value: string) => change("externalAmount", value),
    onExternalMethodChange: (value: string) => change("externalMethod", value),
    onExternalNoteChange: (value: string) => change("externalNote", value),
    onExternalPayerChange: (value: string) => change("externalPayerId", value),
    onRecordExternalPayment: handleRecordExternalPayment,
  };
}
