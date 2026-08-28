import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  canShowPaymentRefund,
  clearRefundRequestKey,
  isPaymentRefundEligible,
  parseRefundAmount,
  postPaymentRefund,
  refreshAfterConfirmedRefund,
  resolveRefundRequestKey,
  safeBrowserRefundStorage,
} from "../src/lib/billing-refund-model.ts";
import { isTerminalBillingIdempotencyError } from "../src/lib/billing-idempotency-lifecycle.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payment = {
  id: "payment-1",
  stripe_charge_id: "redacted-provider-id",
  refundable_amount_cents: 5000,
  adjustment_reconciliation_required: false,
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("billing payment refunds", () => {
  it("shows the workflow only to Admin when the exact server capability is enabled", () => {
    const enabled = new Set(["payment.refund"]);
    assert.equal(canShowPaymentRefund("admin", enabled), true);
    assert.equal(canShowPaymentRefund("front_desk", enabled), false);
    assert.equal(canShowPaymentRefund("instructor", enabled), false);
    assert.equal(canShowPaymentRefund("admin", new Set(["invoice.retry"])), false);
  });

  it("requires a connected, refundable payment without unresolved reconciliation", () => {
    assert.equal(isPaymentRefundEligible(payment), true);
    assert.equal(isPaymentRefundEligible({ ...payment, stripe_charge_id: null }), false);
    assert.equal(isPaymentRefundEligible({ ...payment, refundable_amount_cents: 0 }), false);
    assert.equal(isPaymentRefundEligible({ ...payment, adjustment_reconciliation_required: true }), false);
  });

  it("rejects malformed, zero, and over-refund amounts", () => {
    assert.equal(parseRefundAmount("12.34", 5000), 1234);
    assert.equal(parseRefundAmount("0", 5000), null);
    assert.equal(parseRefundAmount("50.01", 5000), null);
    assert.equal(parseRefundAmount("1.234", 5000), null);
  });

  it("persists the same scoped key across reload and rotates after success", () => {
    const storage = memoryStorage();
    const identity = { userId: "admin-1", studioId: "studio-1" };
    let sequence = 0;
    const createKey = () => `refund-${++sequence}`;
    const first = resolveRefundRequestKey(identity, payment.id, 1250, "duplicate", createKey, storage);
    const replay = resolveRefundRequestKey(identity, payment.id, 1250, "duplicate", createKey, storage);
    assert.equal(replay, first);
    assert.throws(
      () => resolveRefundRequestKey(identity, payment.id, 1300, "duplicate", createKey, storage),
      /unresolved earlier attempt/,
    );
    clearRefundRequestKey(identity, payment.id, storage);
    assert.notEqual(resolveRefundRequestKey(identity, payment.id, 1300, "duplicate", createKey, storage), first);
  });

  it("rejects malformed persisted attempts and survives a throwing storage getter", () => {
    const storage = memoryStorage();
    const identity = { userId: "malformed-admin", studioId: "studio-1" };
    const storageEntries = [];
    const trackingStorage = {
      getItem: storage.getItem,
      setItem: (key, value) => { storageEntries.push(key); storage.setItem(key, value); },
      removeItem: storage.removeItem,
    };
    const initial = resolveRefundRequestKey(identity, payment.id, 900, "duplicate", () => "bounded-key", trackingStorage);
    assert.equal(initial, "bounded-key");
    const storedKey = storageEntries[0];
    storage.setItem(storedKey, JSON.stringify({ amountCents: -1, reason: "invented", requestKey: "" }));
    const reloadedIdentity = { userId: "malformed-admin-2", studioId: "studio-1" };
    const malformedKey = storedKey.replace("malformed-admin", "malformed-admin-2");
    storage.setItem(malformedKey, JSON.stringify({ amountCents: 900, reason: "invented", requestKey: "bad" }));
    assert.equal(
      resolveRefundRequestKey(reloadedIdentity, payment.id, 900, "duplicate", () => "replacement-key", storage),
      "replacement-key",
    );
    const throwingWindow = Object.defineProperty({}, "localStorage", { get() { throw new Error("blocked"); } });
    assert.equal(safeBrowserRefundStorage(throwingWindow), null);
    assert.equal(
      resolveRefundRequestKey({ userId: "memory-admin", studioId: "studio-1" }, payment.id, 900, "duplicate", () => "memory-key", null),
      "memory-key",
    );
  });

  it("retains ambiguous and nonterminal failures but clears the existing terminal 409", () => {
    assert.equal(isTerminalBillingIdempotencyError(new Error("network failure")), false);
    const ambiguous = Object.assign(new Error("still processing"), { status: 409 });
    assert.equal(isTerminalBillingIdempotencyError(ambiguous), false);
    const terminal = Object.assign(new Error("Use a new Idempotency-Key after correcting the request."), { status: 409 });
    assert.equal(isTerminalBillingIdempotencyError(terminal), true);
  });

  it("posts the exact path, generated body shape, and idempotency header", async () => {
    const calls = [];
    const result = await postPaymentRefund({
      amountCents: 1250,
      paymentId: "payment/one",
      post: async (...args) => { calls.push(args); return { id: "refund-1" }; },
      reason: "duplicate",
      requestKey: "refund-key-1",
      token: "token-1",
    });
    assert.deepEqual(result, { id: "refund-1" });
    assert.deepEqual(calls, [[
      "/billing/payments/payment%2Fone/refund",
      { amount_cents: 1250, reason: "duplicate" },
      "token-1",
      { headers: { "Idempotency-Key": "refund-key-1" } },
    ]]);
  });

  it("keeps confirmed mutation success distinct from a later refresh failure", async () => {
    let refreshError = false;
    const refreshed = await refreshAfterConfirmedRefund(
      async () => { throw new Error("read failed"); },
      () => { refreshError = true; },
    );
    assert.equal(refreshed, false);
    assert.equal(refreshError, true);
  });

  it("keeps provider IDs out of the rendered payment UI", () => {
    const source = fs.readFileSync(path.join(root, "src/components/billing/billing-reports-tab.tsx"), "utf8");
    assert.doesNotMatch(source, /stripe_(?:charge|payment_intent|account)_id\s*[}<]/);
    assert.match(source, /window\.confirm/);
    assert.match(source, /refundController\.canRefundPayments/);
    assert.match(source, /refundAmountCents !== null && window\.confirm/);
    assert.match(source, /sm:grid-cols-\[1fr_auto_auto\]/);
  });
});
