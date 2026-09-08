"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
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
  isMatchingRefundResponse,
  markRefundAccepted,
  readRefundAttempt,
  resolveRefundRequestKey,
  safeBrowserRefundStorage,
  type RefundIdentity,
  type RefundReason,
  type RefundAttempt,
  type RefreshPaymentAfterRefund,
} from "@/lib/billing-refund-model";
import type { BillingPayment } from "@/types";

export function useBillingRefundController({
  enabledWorkflowIds,
  identity,
  identityKey,
  isPreviewMode,
  refreshPaymentAfterRefund,
  role,
  setError,
  setMessage,
  token,
}: {
  enabledWorkflowIds: ReadonlySet<string>;
  identity: RefundIdentity | null;
  identityKey: string | null;
  isPreviewMode: boolean;
  refreshPaymentAfterRefund: RefreshPaymentAfterRefund;
  role: string | null;
  setError: (message: string) => void;
  setMessage: (message: string) => void;
  token: string | null;
}) {
  const [activePayment, setActivePayment] = useState<{ scope: string; id: string } | null>(null);
  const [blockedAttempts, setBlockedAttempts] = useState<ReadonlySet<string>>(() => new Set());
  const activeOperationRef = useRef<symbol | null>(null);
  const [, updateReceipts] = useState(0);
  const canRefundPayments = canShowPaymentRefund(role, enabledWorkflowIds);
  const refundStorageReady = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const refundStorage = safeBrowserRefundStorage();
  const refundStorageAvailable = refundStorageReady && refundStorage !== null;
  const refundActionReady = isPreviewMode || refundStorageAvailable;
  const scope = identity && identityKey && canRefundPayments && token && !isPreviewMode ? `${identityKey}:${identity.userId}:${identity.studioId}` : null;
  if (activePayment && activePayment.scope !== scope) setActivePayment(null);
  const activePaymentId = activePayment?.scope === scope ? activePayment.id : null;
  const scopeRef = useRef(scope);
  const messageOwnerRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    scopeRef.current = scope;
    activeOperationRef.current = null;
    if (messageOwnerRef.current !== null && messageOwnerRef.current !== scope) {
      setMessage("");
      messageOwnerRef.current = null;
    }
    return () => { scopeRef.current = null; activeOperationRef.current = null; };
  }, [scope, setMessage]);

  function showRefundMessage(message: string) {
    messageOwnerRef.current = scope;
    setMessage(message);
  }

  function getPaymentRefundRecovery(paymentId: string): "refresh" | "retry" | "unavailable" | null {
    if (isPreviewMode || !identity || !refundStorageAvailable) return null;
    try {
      const attempt = readRefundAttempt(identity, paymentId, refundStorage);
      return attempt ? attempt.acceptedRefundId ? "refresh" : "retry" : null;
    } catch { return "unavailable"; }
  }


  function isPaymentRefundBlocked(paymentId: string) {
    if (isPreviewMode || !identity || !refundStorageAvailable) return false;
    const attemptIdentity = `${identity.userId}\u0000${identity.studioId}\u0000${paymentId}`;
    return blockedAttempts.has(attemptIdentity)
      || Boolean(identity && isRefundReconciliationBlocked(identity, paymentId, refundStorage));
  }

  async function runRefund(payment: BillingPayment, amountCents: number, reason: RefundReason, recovery?: RefundAttempt) {
    if (!identity || !token || !scope || scopeRef.current !== scope || activeOperationRef.current) return;
    if (!refundStorageAvailable || isPaymentRefundBlocked(payment.id)) return;
    const capturedIdentity = identity;
    const operation = Symbol("refund");
    activeOperationRef.current = operation;
    setActivePayment({ scope, id: payment.id });
    setError("");
    setMessage("");
    const current = () => scopeRef.current === scope && activeOperationRef.current === operation;
    const storage = refundStorage;
    let requestKey: string | null = null;
    let accepted = Boolean(recovery?.acceptedRefundId);
    try {
      if (recovery && readRefundAttempt(identity, payment.id, storage)?.requestKey !== recovery.requestKey) {
        throw new Error("The saved refund request changed. Reload Billing before continuing.");
      }
      requestKey = resolveRefundRequestKey(identity, payment.id, amountCents, reason, () => crypto.randomUUID(), storage);
      if (!accepted) {
        const result = await postPaymentRefund({ amountCents, paymentId: payment.id, post: api.post, reason, requestKey, token });
        if (!current()) return;
        if (!isMatchingRefundResponse(result, identity, payment.id, amountCents)) {
          throw new Error("The refund result could not be verified. Recover the original request before starting another refund.");
        }
        if (result.reconciliation_required) {
          markReconciliation();
          return;
        }
        accepted = true;
        showRefundMessage(result.status === "failed" ? "The refund failed. No completed refund is confirmed."
          : result.status === "canceled" ? "The refund was canceled."
          : "Refund submitted. Provider confirmation may take a moment to appear.");
        if (!markRefundAccepted(identity, payment.id, requestKey, result.id, storage)) {
          setError("The refund result was received, but its recovery confirmation could not be saved. Recover the original request before starting another refund.");
          return;
        }
      } else {
        showRefundMessage("The original refund request is recorded. Refreshing its payment balance.");
      }
      const result = await refreshPaymentAfterRefund(payment, identity);
      if (!current()) return;
      if (result.status !== "updated") {
        setError("The refund request is recorded, but its payment balance could not refresh. Use Refresh payment before starting another refund.");
        return;
      }
      if (!clearRefundRequestKey(identity, payment.id, storage, requestKey)) {
        setError("The payment balance refreshed, but its saved recovery state could not be cleared. Reload Billing before taking another action.");
      }
    } catch (error) {
      if (!current()) return;
      if (isRefundReconciliationRequiredError(error)) {
        markReconciliation();
        return;
      }
      // A rejection of a replay cannot prove that its earlier uncertain request never committed.
      if (!accepted && !recovery && requestKey && (isTerminalBillingIdempotencyError(error) || isDefinitiveRefundRejection(error))) {
        if (!clearRefundRequestKey(identity, payment.id, storage, requestKey)) {
          setError("The refund was rejected, but its saved request state could not be cleared. Reload Billing before correcting and retrying.");
          return;
        }
      }
      setError(accepted ? "The refund request is recorded, but its payment balance could not refresh. Use Refresh payment before starting another refund."
        : error instanceof Error ? error.message : "Refund could not be submitted.");
    } finally {
      if (current()) {
        activeOperationRef.current = null;
        setActivePayment(null);
        updateReceipts(version => version + 1);
      }
    }

    function markReconciliation() {
      const attemptIdentity = `${capturedIdentity.userId}\u0000${capturedIdentity.studioId}\u0000${payment.id}`;
      setBlockedAttempts(previous => new Set(previous).add(attemptIdentity));
      const saved = markRefundReconciliationRequired(capturedIdentity, payment.id, storage);
      setError(saved ? "This refund needs reconciliation outside Koaryu. Refund retry is disabled for this payment."
        : "This refund needs reconciliation, but the recovery marker could not be saved. Do not retry it from this browser.");
    }
  }

  async function refundPayment(payment: BillingPayment, amount: string, reason: RefundReason) {
    if (!canRefundPayments || !isPaymentRefundEligible(payment)) return;
    if (isPaymentRefundBlocked(payment.id)) {
      setError("This refund needs reconciliation outside Koaryu. Refund retry is disabled for this payment.");
      return;
    }
    if (getPaymentRefundRecovery(payment.id)) {
      setError("Recover the original refund request before starting another refund.");
      return;
    }
    const amountCents = parseRefundAmount(amount, payment.refundable_amount_cents);
    if (amountCents === null) {
      setError("Enter an amount greater than $0 and no more than the refundable balance.");
      return;
    }
    if (isPreviewMode) { setMessage("Preview mode does not send refunds."); return; }
    if (!refundStorageAvailable) {
      setError("Refunds are unavailable because this browser cannot safely save the request. Enable browser storage and reload this page.");
      return;
    }
    await runRefund(payment, amountCents, reason);
  }

  async function recoverRefund(payment: BillingPayment) {
    if (!canRefundPayments || isPreviewMode || !identity || isPaymentRefundBlocked(payment.id)) return;
    try {
      const attempt = readRefundAttempt(identity, payment.id, refundStorage);
      if (attempt) await runRefund(payment, attempt.amountCents, attempt.reason, attempt);
    } catch {
      setError("The saved refund request could not be read. Reload Billing before taking another action.");
    }
  }

  return {
    activePaymentId,
    canRefundPayments,
    isPaymentRefundBlocked,
    getPaymentRefundRecovery,
    recoverRefund,
    refundPayment,
    refundActionReady,
    refundStorageAvailable,
    refundStorageReady,
  };
}

export type BillingRefundController = ReturnType<typeof useBillingRefundController>;
