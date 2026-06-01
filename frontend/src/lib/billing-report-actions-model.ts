import type { ExternalBillingPaymentPayload } from "@/lib/billing-page-form-model";
import type { BillingPayment } from "@/types";

export type BillingPaymentPost = <T>(
  path: string,
  body: unknown,
  token?: string,
  options?: { headers?: Record<string, string> }
) => Promise<T>;

export function createExternalPaymentRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `external-payment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
