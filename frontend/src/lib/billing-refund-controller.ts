"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { isTerminalBillingIdempotencyError } from "@/lib/billing-idempotency-lifecycle";
import {
  canShowPaymentRefund,
  clearRefundRequestKey,
  isDefinitiveRefundRejection,
  isRefundReconciliationBlocked,
  isRefundReconciliationRequiredError,
  isPaymentRefundEligible,
  markRefundReconciliationRequired,
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
  const [blockedAttempts, setBlockedAttempts] = useState<ReadonlySet<string>>(() => new Set());
  const activePaymentIdRef = useRef<string | null>(null);
  const canRefundPayments = canShowPaymentRefund(role, enabledWorkflowIds);
  const refundStorageReady = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const refundStorage = safeBrowserRefundStorage();
  const refundStorageAvailable = refundStorageReady && refundStorage !== null;
  const refundActionReady = isPreviewMode || refundStorageAvailable;

  function isPaymentRefundBlocked(paymentId: string) {
    if (isPreviewMode || !identity || !refundStorageAvailable) return false;
    const attemptIdentity = `${identity.userId}\u0000${identity.studioId}\u0000${paymentId}`;
    return blockedAttempts.has(attemptIdentity)
      || Boolean(identity && isRefundReconciliationBlocked(identity, paymentId, refundStorage));
  }

  async function refundPayment(payment: BillingPayment, amount: string, reason: RefundReason) {
    if (!canRefundPayments || !isPaymentRefundEligible(payment)) return;
    if (isPaymentRefundBlocked(payment.id)) {
      setError("This refund needs reconciliation outside Koaryu. Refund retry is disabled for this payment.");
      return;
    }
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
    if (!refundStorageAvailable) {
      setError("Refunds are unavailable because this browser cannot safely save the request. Enable browser storage and reload this page.");
      return;
    }
    activePaymentIdRef.current = payment.id;
    setActivePaymentId(payment.id);
    setError("");
    const storage = refundStorage;
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
      setMessage("Refund submitted. Provider confirmation may take a moment to appear.");
      const refreshed = await refreshAfterConfirmedRefund(refreshBilling, () => {
        setError("The refund succeeded, but Billing could not refresh. Refresh the page before taking another action.");
      });
      if (refreshed && !clearRefundRequestKey(identity, payment.id, storage)) {
        setError("The refund succeeded, but its saved recovery state could not be cleared. Reload Billing before taking another action.");
      }
    } catch (error) {
      if (isRefundReconciliationRequiredError(error)) {
        if (!markRefundReconciliationRequired(identity, payment.id, storage)) {
          setError("This refund needs reconciliation, but the recovery marker could not be saved. Do not retry it from this browser.");
          return;
        }
        const attemptIdentity = `${identity.userId}\u0000${identity.studioId}\u0000${payment.id}`;
        setBlockedAttempts((current) => new Set(current).add(attemptIdentity));
        setError("This refund needs reconciliation outside Koaryu. Refund retry is disabled for this payment.");
        return;
      } else if (isTerminalBillingIdempotencyError(error) || isDefinitiveRefundRejection(error)) {
        if (!clearRefundRequestKey(identity, payment.id, storage)) {
          setError("The refund was rejected, but its saved request state could not be cleared. Reload Billing before correcting and retrying.");
          return;
        }
      }
      setError(error instanceof Error ? error.message : "Refund could not be submitted.");
      return;
    } finally {
      activePaymentIdRef.current = null;
      setActivePaymentId(null);
    }
  }

  return {
    activePaymentId,
    canRefundPayments,
    isPaymentRefundBlocked,
    refundPayment,
    refundActionReady,
    refundStorageAvailable,
    refundStorageReady,
  };
}

export type BillingRefundController = ReturnType<typeof useBillingRefundController>;
