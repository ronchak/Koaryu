"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { BillingActionRuntime } from "@/lib/billing-action-runtime";
import { buildBillingPayerCreatePayload } from "@/lib/billing-page-form-model";
import type { BillingLinkResponse, BillingPayer } from "@/types";

export function useBillingPayerActions(runtime: BillingActionRuntime) {
  const [payerName, setPayerName] = useState("");
  const [payerEmail, setPayerEmail] = useState("");
  const [payerPhone, setPayerPhone] = useState("");

  function resetPayerForm() {
    setPayerName("");
    setPayerEmail("");
    setPayerPhone("");
  }

  async function handlePayerSync(payerId: string) {
    await runtime.postBillingAction<BillingPayer>({
      action: `payer-sync:${payerId}`,
      path: `/billing/payers/${payerId}/sync`,
      successMessage: "Payer sync requested.",
    });
  }

  async function handleAutopaySetup(payerId: string) {
    const accepted = window.confirm("Confirm this payer has authorized Koaryu autopay terms for future charges.");
    if (!accepted) return;
    const link = await runtime.postBillingAction<BillingLinkResponse>({
      action: `autopay-setup:${payerId}`,
      body: { return_url: window.location.href, terms_accepted: true },
      path: `/billing/payers/${payerId}/autopay/setup-link`,
      successMessage: "Opening Stripe autopay setup.",
    });
    if (link?.url) {
      window.location.assign(link.url);
    }
  }

  async function handleAutopayDisable(payerId: string) {
    await runtime.postBillingAction<BillingPayer>({
      action: `autopay-disable:${payerId}`,
      path: `/billing/payers/${payerId}/autopay/disable`,
      successMessage: "Autopay disabled.",
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
