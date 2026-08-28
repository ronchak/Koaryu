"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { isTerminalBillingIdempotencyError } from "@/lib/billing-idempotency-lifecycle";
import {
  canShowPaymentRefund,
  clearRefundRequestKey,
  isPaymentRefundEligible,
  parseRefundAmount,
  postPaymentRefund,
  refreshAfterConfirmedRefund,
  resolveRefundRequestKey,
  safeBrowserRefundStorage,
  type RefundIdentity,
  type RefundReason,
} from "@/lib/billing-refund-model";
import type { BillingPayment } from "@/types";

export function useBillingRefundController({
  enabledWorkflowIds,
  identity,
  isPreviewMode,
  refreshBilling,
  role,
  setError,
  setMessage,
  token,
}: {
  enabledWorkflowIds: ReadonlySet<string>;
  identity: RefundIdentity | null;
  isPreviewMode: boolean;
  refreshBilling: () => Promise<void>;
  role: string | null;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
  token: string | null;
}) {
  const [activePaymentId, setActivePaymentId] = useState<string | null>(null);
  const activePaymentIdRef = useRef<string | null>(null);
  const canRefundPayments = canShowPaymentRefund(role, enabledWorkflowIds);

  async function refundPayment(payment: BillingPayment, amount: string, reason: RefundReason) {
    if (!canRefundPayments || !isPaymentRefundEligible(payment)) return;
    const amountCents = parseRefundAmount(amount, payment.refundable_amount_cents);
    if (amountCents === null) {
      setError("Enter an amount greater than $0 and no more than the refundable balance.");
      return;
    }
    if (isPreviewMode) {
      setMessage("Preview mode does not send refunds.");
      return;
    }
    if (!identity || !token || activePaymentIdRef.current) return;
    activePaymentIdRef.current = payment.id;
    setActivePaymentId(payment.id);
    setError("");
    const storage = safeBrowserRefundStorage();
    try {
      const requestKey = resolveRefundRequestKey(
        identity,
        payment.id,
        amountCents,
        reason,
        () => crypto.randomUUID(),
        storage,
      );
      await postPaymentRefund({ amountCents, paymentId: payment.id, post: api.post, reason, requestKey, token });
      clearRefundRequestKey(identity, payment.id, storage);
      setMessage("Refund submitted. Provider confirmation may take a moment to appear.");
      await refreshAfterConfirmedRefund(refreshBilling, () => {
        setError("The refund succeeded, but Billing could not refresh. Refresh the page before taking another action.");
      });
    } catch (error) {
      if (isTerminalBillingIdempotencyError(error)) {
        clearRefundRequestKey(identity, payment.id, storage);
      }
      setError(error instanceof Error ? error.message : "Refund could not be submitted.");
      return;
    } finally {
      activePaymentIdRef.current = null;
      setActivePaymentId(null);
    }
  }

  return { activePaymentId, canRefundPayments, refundPayment };
}

export type BillingRefundController = ReturnType<typeof useBillingRefundController>;
