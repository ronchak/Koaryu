"use client";

import { useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { BillingActionRuntime } from "@/lib/billing-action-runtime";
import { buildBillingPayerCreatePayload } from "@/lib/billing-page-form-model";
import {
  buildPayerSyncRequest,
  buildPayerAutopaySetupRequest,
  clearPersistedPayerOperationRequestKey,
  copyPayerAutopaySetupLink,
  getPayerAutopaySetupReturnUrl,
  resolvePersistedPayerOperationRequestKey,
  type PayerOperationIdentity,
} from "@/lib/billing-payer-setup-model";
import type { BillingLinkResponse, BillingPayer } from "@/types";

export function useBillingPayerActions(
  runtime: BillingActionRuntime,
  identity: PayerOperationIdentity | null,
) {
  const autopaySetupKeysRef = useRef(new Map<string, string>());
  const payerSyncKeysRef = useRef(new Map<string, string>());
  const [payerName, setPayerName] = useState("");
  const [payerEmail, setPayerEmail] = useState("");
  const [payerPhone, setPayerPhone] = useState("");

  function resetPayerForm() {
    setPayerName("");
    setPayerEmail("");
    setPayerPhone("");
  }

  async function handlePayerSync(
    payerId: string,
    options: { startNewRequest?: boolean } = {},
  ) {
    const requestKey = resolvePersistedPayerOperationRequestKey({
      identity,
      keysByPayer: payerSyncKeysRef.current,
      operation: "payer.sync",
      payerId,
      startNewRequest: options.startNewRequest,
    });
    const request = buildPayerSyncRequest(requestKey);
    const result = await runtime.postBillingAction<BillingPayer>({
      action: `payer-sync:${payerId}`,
      path: `/billing/payers/${payerId}/sync`,
      onTerminalIdempotencyError: () => clearPersistedPayerOperationRequestKey({
        identity,
        keysByPayer: payerSyncKeysRef.current,
        operation: "payer.sync",
        payerId,
      }),
      refresh: false,
      requestOptions: { headers: request.headers },
      successMessage: "Payer sync requested.",
      workflowId: "payer.sync",
    });
    if (result) {
      clearPersistedPayerOperationRequestKey({
        identity,
        keysByPayer: payerSyncKeysRef.current,
        operation: "payer.sync",
        payerId,
      });
      try {
        await runtime.refreshBilling();
      } catch {
        runtime.setError("Payer synced, but billing data could not be refreshed.");
      }
    }
    return result;
  }

  async function handleAutopaySetup(
    payerId: string,
    options: { startNewRequest?: boolean } = {},
  ) {
    const requestKey = resolvePersistedPayerOperationRequestKey({
      identity,
      keysByPayer: autopaySetupKeysRef.current,
      operation: "payer.setup",
      payerId,
      startNewRequest: options.startNewRequest,
    });
    const request = buildPayerAutopaySetupRequest(
      getPayerAutopaySetupReturnUrl(window.location.origin),
      requestKey,
    );
    const link = await runtime.postBillingAction<BillingLinkResponse>({
      action: `autopay-setup:${payerId}`,
      body: request.body,
      path: `/billing/payers/${payerId}/autopay/setup-link`,
      onTerminalIdempotencyError: () => clearPersistedPayerOperationRequestKey({
        identity,
        keysByPayer: autopaySetupKeysRef.current,
        operation: "payer.setup",
        payerId,
      }),
      refresh: false,
      requestOptions: { headers: request.headers },
      successMessage: "Stripe autopay setup link created.",
      workflowId: "payer.setup",
    });
    if (link?.url) {
      const copied = await copyPayerAutopaySetupLink(link.url);
      runtime.setMessage(
        copied
          ? "Stripe autopay setup link copied."
          : `Stripe autopay setup link: ${link.url}`,
      );
    }
    return link?.url ?? null;
  }

  async function handleAutopayDisable(payerId: string) {
    await runtime.postBillingAction<BillingPayer>({
      action: `autopay-disable:${payerId}`,
      path: `/billing/payers/${payerId}/autopay/disable`,
      successMessage: "Autopay disabled.",
      workflowId: "payer.autopay.disable",
    });
  }

  async function handleCreatePayer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runtime.setError("");
    runtime.setMessage("");
    const payloadResult = buildBillingPayerCreatePayload({ payerName, payerEmail, payerPhone });
    if (!payloadResult.ok) {
      runtime.setError(payloadResult.error);
      return;
    }
    if (runtime.isPreviewMode) {
      runtime.setMessage("Demo payer created locally.");
      resetPayerForm();
      return;
    }
    if (!runtime.canUseWorkflow("payer.create")) {
      runtime.setError("Payer creation is not available for the current studio and role.");
      return;
    }
    if (!runtime.token || !runtime.claimAction("create-payer")) {
      return;
    }
    try {
      await api.post<BillingPayer>("/billing/payers", payloadResult.payload, runtime.token);
      runtime.setMessage("Family payer created.");
      resetPayerForm();
      await runtime.refreshBilling();
    } catch (err) {
      runtime.setError(err instanceof Error ? err.message : "Family payer could not be created.");
    } finally {
      runtime.releaseAction("create-payer");
    }
  }

  return {
    onAutopayDisable: handleAutopayDisable,
    onAutopaySetup: handleAutopaySetup,
    onCreatePayer: handleCreatePayer,
    onPayerEmailChange: setPayerEmail,
    onPayerNameChange: setPayerName,
    onPayerPhoneChange: setPayerPhone,
    onPayerSync: handlePayerSync,
    payerEmail,
    payerName,
    payerPhone,
  };
}
