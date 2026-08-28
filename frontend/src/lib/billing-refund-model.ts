import type { ApiBillingRefundCreate, ApiBillingRefundResponse } from "@/types/generated/api-contracts";
import type { BillingPayment } from "@/types";

export type RefundStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type RefundIdentity = { userId: string; studioId: string };
export type RefundReason = NonNullable<ApiBillingRefundCreate["reason"]>;

const STORAGE_PREFIX = "koaryu.billing.payment-refund.v1";
const memoryAttempts = new Map<string, RefundAttempt>();
type RefundAttempt = { amountCents: number; reason: RefundReason; requestKey: string };
const REFUND_REASONS = new Set<RefundReason>(["duplicate", "fraudulent", "requested_by_customer"]);

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
  let existing = memoryAttempts.get(key);
  try {
    const stored = storage?.getItem(key) ?? null;
    const parsed = parseStoredAttempt(stored);
    if (parsed) existing = parsed;
    else if (stored) storage?.removeItem(key);
  } catch {
    // The exact scoped in-memory attempt remains authoritative for this page lifetime.
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
  memoryAttempts.set(key, attempt);
  try { storage?.setItem(key, JSON.stringify(attempt)); } catch {}
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
