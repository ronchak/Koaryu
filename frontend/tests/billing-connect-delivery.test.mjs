import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeConnectOnboardingBeforeNavigation,
} from "../src/lib/billing-connect-delivery.ts";

test("acknowledges an initial-link receipt before navigating", async () => {
  const calls = [];
  await acknowledgeConnectOnboardingBeforeNavigation(
    { pending_url: "https://connect.stripe.test/link", delivery_receipt: "receipt" },
    async (receipt) => calls.push(["ack", receipt]),
    (url) => calls.push(["navigate", url]),
  );

  assert.deepEqual(calls, [
    ["ack", "receipt"],
    ["navigate", "https://connect.stripe.test/link"],
  ]);
});

test("never navigates when delivery acknowledgement fails", async () => {
  const navigations = [];
  await assert.rejects(
    acknowledgeConnectOnboardingBeforeNavigation(
      { pending_url: "https://connect.stripe.test/link", delivery_receipt: "receipt" },
      async () => { throw new Error("support required"); },
      (url) => navigations.push(url),
    ),
    /support required/,
  );
  assert.deepEqual(navigations, []);
});

test("ordinary checkpoint-bound links navigate without a bootstrap receipt", async () => {
  const calls = [];
  await acknowledgeConnectOnboardingBeforeNavigation(
    { pending_url: "https://connect.stripe.test/fresh", delivery_receipt: null },
    async () => calls.push("ack"),
    (url) => calls.push(url),
  );
  assert.deepEqual(calls, ["https://connect.stripe.test/fresh"]);
});

test("old or malformed responses without pending_url fail closed", async () => {
  const navigations = [];
  await assert.rejects(
    acknowledgeConnectOnboardingBeforeNavigation(
      { url: "https://connect.stripe.test/legacy" },
      async () => undefined,
      (url) => navigations.push(url),
    ),
    /did not return a pending URL/,
  );
  assert.deepEqual(navigations, []);
});
