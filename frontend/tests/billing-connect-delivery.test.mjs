import assert from "node:assert/strict";
import test from "node:test";

import { acknowledgeConnectOnboardingBeforeNavigation } from "../src/lib/billing-connect-delivery.ts";

test("acknowledges an initial-link receipt before navigating", async () => {
  const calls = [];
  await acknowledgeConnectOnboardingBeforeNavigation(
    { pending_url: "https://connect.stripe.test/link", delivery_receipt: "receipt" },
    async (receipt) => calls.push(["ack", receipt]),
    (url) => calls.push(["navigate", url]),
    () => true,
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
      async () => {
        throw new Error("support required");
      },
      (url) => navigations.push(url),
      () => true,
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
    () => true,
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
      () => true,
    ),
    /did not return a pending URL/,
  );
  assert.deepEqual(navigations, []);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("navigates only after acknowledgement while the owner is still current", async () => {
  const ack = deferred();
  const calls = [];
  const pending = acknowledgeConnectOnboardingBeforeNavigation(
    { pending_url: "https://connect.stripe.test/link", delivery_receipt: "receipt" },
    async (receipt) => {
      calls.push(["ack", receipt]);
      await ack.promise;
    },
    (url) => calls.push(["navigate", url]),
    () => true,
  );
  await Promise.resolve();
  assert.deepEqual(calls, [["ack", "receipt"]]);
  ack.resolve();
  assert.equal(await pending, true);
  assert.deepEqual(calls, [
    ["ack", "receipt"],
    ["navigate", "https://connect.stripe.test/link"],
  ]);
});

test("does not navigate when the owner leaves while acknowledgement is pending", async () => {
  const ack = deferred();
  const acknowledged = [];
  const navigations = [];
  let owned = true;
  const pending = acknowledgeConnectOnboardingBeforeNavigation(
    { pending_url: "https://connect.stripe.test/link", delivery_receipt: "receipt" },
    async (receipt) => {
      await ack.promise;
      acknowledged.push(receipt);
    },
    (url) => navigations.push(url),
    () => owned,
  );
  owned = false;
  ack.resolve();
  const navigated = await pending;
  assert.deepEqual(acknowledged, ["receipt"]);
  assert.deepEqual(navigations, []);
  assert.equal(navigated, false);
});

test("awaits an asynchronous ownership check before navigating", async () => {
  const ownership = deferred();
  const navigations = [];
  const pending = acknowledgeConnectOnboardingBeforeNavigation(
    { pending_url: "https://connect.stripe.test/fresh", delivery_receipt: null },
    async () => undefined,
    (url) => navigations.push(url),
    () => ownership.promise,
  );
  await Promise.resolve();
  assert.deepEqual(navigations, []);
  ownership.resolve(false);
  assert.equal(await pending, false);
  assert.deepEqual(navigations, []);
});
