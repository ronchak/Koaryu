import type { ExternalBillingPaymentPayload } from "@/lib/billing-page-form-model";
import type { BillingPayment } from "@/types";

export type BillingPaymentPost = <T>(
  path: string,
  body: unknown,
  token?: string,
  options?: { headers?: Record<string, string> },
) => Promise<T>;

export function createExternalPaymentRequestKey() {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error(
      "This browser cannot create a secure payment request. Update your browser before recording a payment.",
    );
  }
  return crypto.randomUUID();
}

export async function postExternalBillingPayment({
  payload,
  post,
  requestKey,
  token,
}: {
  payload: ExternalBillingPaymentPayload;
  post: BillingPaymentPost;
  requestKey: string;
  token: string;
}) {
  return post<BillingPayment>("/billing/payments/external", payload, token, {
    headers: { "Idempotency-Key": requestKey },
  });
}

export type ExternalPaymentIdentity = { userId: string; studioId: string };
export type ExternalPaymentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type ExternalPaymentAttempt = {
  version: 1;
  requestKey: string;
  payload: ExternalBillingPaymentPayload;
};

const storageUnavailable =
  "Browser storage is unavailable. Enable it and reload this page before recording a payment.";
const invalidRecovery =
  "A saved payment request cannot be verified. Contact support before recording this payment again.";

export function browserExternalPaymentStorage(): ExternalPaymentStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function attemptStorageKey(identity: ExternalPaymentIdentity) {
  return `koaryu.external-payment:${encodeURIComponent(identity.userId)}:${encodeURIComponent(identity.studioId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExternalPaymentAttempt(value: unknown): value is ExternalPaymentAttempt {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.requestKey !== "string" ||
    !value.requestKey.trim() ||
    new TextEncoder().encode(value.requestKey).length > 255 ||
    Object.keys(value).some((key) => !["version", "requestKey", "payload"].includes(key))
  )
    return false;
  const payload = value.payload;
  return (
    isRecord(payload) &&
    Object.keys(payload).every((key) =>
      ["payer_id", "amount_cents", "currency", "external_method", "note", "invoice_id"].includes(
        key,
      ),
    ) &&
    typeof payload.payer_id === "string" &&
    payload.payer_id.length > 0 &&
    typeof payload.amount_cents === "number" &&
    Number.isSafeInteger(payload.amount_cents) &&
    payload.amount_cents >= 1 &&
    payload.amount_cents <= 2_147_483_647 &&
    payload.currency === "usd" &&
    payload.invoice_id == null &&
    typeof payload.external_method === "string" &&
    payload.external_method.trim().length > 0 &&
    payload.external_method.length <= 80 &&
    (payload.note == null || typeof payload.note === "string")
  );
}

export function readExternalPaymentAttempt(
  identity: ExternalPaymentIdentity,
  storage: ExternalPaymentStorage | null,
) {
  if (!storage) throw new Error(storageUnavailable);
  let raw: string | null;
  try {
    raw = storage.getItem(attemptStorageKey(identity));
  } catch {
    throw new Error(storageUnavailable);
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(invalidRecovery);
  }
  if (!isExternalPaymentAttempt(value)) throw new Error(invalidRecovery);
  return value;
}

export function sameExternalPaymentAttempt(
  left: ExternalPaymentAttempt,
  right: ExternalPaymentAttempt,
) {
  return (
    left.requestKey === right.requestKey &&
    left.payload.payer_id === right.payload.payer_id &&
    left.payload.amount_cents === right.payload.amount_cents &&
    left.payload.currency === right.payload.currency &&
    left.payload.external_method === right.payload.external_method &&
    (left.payload.note ?? null) === (right.payload.note ?? null) &&
    (left.payload.invoice_id ?? null) === (right.payload.invoice_id ?? null)
  );
}

export function retainExternalPaymentAttempt(
  identity: ExternalPaymentIdentity,
  attempt: ExternalPaymentAttempt,
  storage: ExternalPaymentStorage | null,
) {
  if (!isExternalPaymentAttempt(attempt)) throw new Error(invalidRecovery);
  const existing = readExternalPaymentAttempt(identity, storage);
  if (existing && !sameExternalPaymentAttempt(existing, attempt)) {
    throw new Error(
      "The saved payment request changed. Reload this page to recover the original request.",
    );
  }
  if (!existing) {
    try {
      storage!.setItem(attemptStorageKey(identity), JSON.stringify(attempt));
    } catch {
      throw new Error(storageUnavailable);
    }
  }
  const saved = readExternalPaymentAttempt(identity, storage);
  if (!saved || !sameExternalPaymentAttempt(saved, attempt)) throw new Error(storageUnavailable);
}

export function retireExternalPaymentAttempt(
  identity: ExternalPaymentIdentity,
  attempt: ExternalPaymentAttempt,
  storage: ExternalPaymentStorage | null,
) {
  const existing = readExternalPaymentAttempt(identity, storage);
  if (existing && !sameExternalPaymentAttempt(existing, attempt)) {
    throw new Error("The saved payment request changed. Reload this page before continuing.");
  }
  if (!existing) return;
  try {
    storage!.removeItem(attemptStorageKey(identity));
  } catch {
    throw new Error(storageUnavailable);
  }
  if (readExternalPaymentAttempt(identity, storage) !== null) throw new Error(storageUnavailable);
}

export function isMatchingExternalPaymentResponse(
  value: unknown,
  identity: ExternalPaymentIdentity,
  attempt: ExternalPaymentAttempt,
) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.studio_id === identity.studioId &&
    value.payer_id === attempt.payload.payer_id &&
    value.amount_cents === attempt.payload.amount_cents &&
    value.currency === attempt.payload.currency &&
    value.external_method === attempt.payload.external_method &&
    (value.note ?? null) === (attempt.payload.note ?? null) &&
    value.invoice_id == null &&
    value.status === "externally_recorded" &&
    value.payment_method_type === "external"
  );
}
