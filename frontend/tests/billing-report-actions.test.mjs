import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createExternalPaymentRequestKey,
  postExternalBillingPayment,
} from "../src/lib/billing-report-actions-model.ts";

describe("billing report actions", () => {
  it("posts external payments with the stable idempotency key supplied by the submit flow", async () => {
    const calls = [];
    const payload = {
      payer_id: "payer-1",
      amount_cents: 7525,
      currency: "usd",
      external_method: "Check",
      note: "paid at front desk",
    };

    const result = await postExternalBillingPayment({
      payload,
      requestKey: "external-payment-key-1",
      token: "token-1",
      post: async (...args) => {
        calls.push(args);
        return { id: "payment-1" };
      },
    });

    assert.deepEqual(result, { id: "payment-1" });
    assert.deepEqual(calls, [[
      "/billing/payments/external",
      payload,
      "token-1",
      { headers: { "Idempotency-Key": "external-payment-key-1" } },
    ]]);
  });

  it("creates external payment request keys with a stable namespace", () => {
    const key = createExternalPaymentRequestKey();

    assert.match(key, /^[0-9a-f-]{36}$|^external-payment-/);
  });
});
