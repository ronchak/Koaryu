import type { ApiBillingRefundCreate, ApiBillingRefundResponse } from "@/types/generated/api-contracts";
import type { BillingPayment } from "@/types";

export type RefundStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type RefundIdentity = { userId: string; studioId: string };
export type RefundReason = NonNullable<ApiBillingRefundCreate["reason"]>;

const STORAGE_PREFIX = "koaryu.billing.payment-refund.v1";
const memoryAttempts = new Map<string, RefundAttempt>();
type RefundAttempt = {
  amountCents: number;
  reason: RefundReason;
  requestKey: string;
  disposition?: "reconciliation_required";
};
const REFUND_REASONS = new Set<RefundReason>(["duplicate", "fraudulent", "requested_by_customer"]);
const RECONCILIATION_REQUIRED_DETAIL = "This billing operation requires reconciliation and will not be retried automatically.";
const REFUND_STORAGE_UNAVAILABLE_DETAIL = "Refunds are unavailable because this browser cannot safely save the request. Enable browser storage and reload this page.";

function validRequestKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
    && new TextEncoder().encode(value).byteLength <= 255;
}

function parseStoredAttempt(value: string | null): RefundAttempt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      !Number.isSafeInteger(record.amountCents)
      || (record.amountCents as number) <= 0
      || typeof record.reason !== "string"
      || !REFUND_REASONS.has(record.reason as RefundReason)
      || !validRequestKey(record.requestKey)
      || (record.disposition !== undefined && record.disposition !== "reconciliation_required")
    ) return null;
    return record as RefundAttempt;
  } catch {
    return null;
  }
}

export function safeBrowserRefundStorage(browser: Pick<Window, "localStorage"> | null = typeof window === "undefined" ? null : window) {
  try { return browser?.localStorage ?? null; } catch { return null; }
}

function storageKey(identity: RefundIdentity, paymentId: string) {
  return [STORAGE_PREFIX, identity.userId, identity.studioId, "payment.refund", paymentId]
    .map(encodeURIComponent)
    .join(":");
}

export function canShowPaymentRefund(role: string | null, workflows: ReadonlySet<string>) {
  return role === "admin" && workflows.has("payment.refund");
}

export function isPaymentRefundEligible(payment: BillingPayment) {
  return Boolean(payment.stripe_charge_id)
    && payment.refundable_amount_cents > 0
    && !payment.adjustment_reconciliation_required;
}

export function parseRefundAmount(value: string, maximumCents: number) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= maximumCents ? cents : null;
}

export function refundRequest(
  paymentId: string,
  amountCents: number,
  reason: RefundReason,
  requestKey: string,
) {
  const body: ApiBillingRefundCreate = { amount_cents: amountCents, reason };
  return {
    path: `/billing/payments/${encodeURIComponent(paymentId)}/refund`,
    body,
    headers: { "Idempotency-Key": requestKey },
  };
}

export function resolveRefundRequestKey(
  identity: RefundIdentity,
  paymentId: string,
  amountCents: number,
  reason: RefundReason,
  createKey: () => string,
  storage: RefundStorage | null,
) {
  const key = storageKey(identity, paymentId);
  if (!storage) {
    memoryAttempts.delete(key);
    throw new Error(REFUND_STORAGE_UNAVAILABLE_DETAIL);
  }
  let stored: string | null;
  try {
    stored = storage.getItem(key);
  } catch {
    memoryAttempts.delete(key);
    throw new Error(REFUND_STORAGE_UNAVAILABLE_DETAIL);
  }
  if (stored === null && memoryAttempts.has(key)) {
    memoryAttempts.delete(key);
    throw new Error(REFUND_STORAGE_UNAVAILABLE_DETAIL);
  }
  const existing = parseStoredAttempt(stored);
  if (stored && !existing) {
    memoryAttempts.delete(key);
    try { storage.removeItem(key); } catch {}
    throw new Error(REFUND_STORAGE_UNAVAILABLE_DETAIL);
  }
  if (existing) {
    if (existing.amountCents !== amountCents || existing.reason !== reason) {
      throw new Error("This refund has an unresolved earlier attempt. Retry the original amount and reason.");
    }
    memoryAttempts.set(key, existing);
    return existing.requestKey;
  }
  const requestKey = createKey();
  if (!validRequestKey(requestKey)) throw new Error("Refund request key is invalid.");
  const attempt = { amountCents, reason, requestKey };
  try {
    storage.setItem(key, JSON.stringify(attempt));
    const persisted = parseStoredAttempt(storage.getItem(key));
    if (
      !persisted
      || persisted.amountCents !== attempt.amountCents
      || persisted.reason !== attempt.reason
      || persisted.requestKey !== attempt.requestKey
      || persisted.disposition !== undefined
    ) {
      throw new Error(REFUND_STORAGE_UNAVAILABLE_DETAIL);
    }
  } catch {
    memoryAttempts.delete(key);
    try { storage.removeItem(key); } catch {}
    throw new Error(REFUND_STORAGE_UNAVAILABLE_DETAIL);
  }
  memoryAttempts.set(key, attempt);
  return attempt.requestKey;
}

export async function refreshAfterConfirmedRefund(
  refresh: () => Promise<void>,
  onRefreshError: () => void,
) {
  try {
    await refresh();
    return true;
  } catch {
    onRefreshError();
    return false;
  }
}

export function clearRefundRequestKey(identity: RefundIdentity, paymentId: string, storage: RefundStorage | null) {
  const key = storageKey(identity, paymentId);
  memoryAttempts.delete(key);
  try { storage?.removeItem(key); } catch {}
}

export function isRefundReconciliationRequiredError(error: unknown) {
  return error instanceof Error
    && "status" in error
    && error.status === 409
    && error.message === RECONCILIATION_REQUIRED_DETAIL;
}

export function markRefundReconciliationRequired(
  identity: RefundIdentity,
  paymentId: string,
  storage: RefundStorage | null,
) {
  const key = storageKey(identity, paymentId);
  let attempt = memoryAttempts.get(key);
  try {
    const parsed = parseStoredAttempt(storage?.getItem(key) ?? null);
    if (parsed) attempt = parsed;
  } catch {
    // Keep the page-lifetime attempt when browser storage is unavailable.
  }
  if (!attempt) return false;
  const blockedAttempt = { ...attempt, disposition: "reconciliation_required" } as const;
  memoryAttempts.set(key, blockedAttempt);
  try { storage?.setItem(key, JSON.stringify(blockedAttempt)); } catch {}
  return true;
}

export function isRefundReconciliationBlocked(
  identity: RefundIdentity,
  paymentId: string,
  storage: RefundStorage | null,
) {
  const key = storageKey(identity, paymentId);
  const inMemory = memoryAttempts.get(key);
  if (inMemory?.disposition === "reconciliation_required") return true;
  try {
    const persisted = parseStoredAttempt(storage?.getItem(key) ?? null);
    if (!persisted) return false;
    return persisted.disposition === "reconciliation_required";
  } catch {
    return false;
  }
}

export type RefundPost = <T>(
  path: string,
  body: unknown,
  token?: string,
  options?: { headers?: Record<string, string> },
) => Promise<T>;

export async function postPaymentRefund({
  amountCents,
  paymentId,
  post,
  reason,
  requestKey,
  token,
}: {
  amountCents: number;
  paymentId: string;
  post: RefundPost;
  reason: RefundReason;
  requestKey: string;
  token: string;
}) {
  const request = refundRequest(paymentId, amountCents, reason, requestKey);
  return post<ApiBillingRefundResponse>(request.path, request.body, token, { headers: request.headers });
}
