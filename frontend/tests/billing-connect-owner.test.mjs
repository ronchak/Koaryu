import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  acknowledgeConnectOnboardingBeforeNavigation,
  createConnectOnboardingOwnerTracker,
  isSameConnectOnboardingOwner,
  ownsConnectOnboardingNavigation,
} from "../src/lib/billing-connect-delivery.ts";

const link = { pending_url: "https://connect.stripe.test/link", delivery_receipt: "receipt" };
const owner = { userId: "user-1", studioId: "studio-1" };

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// Starts delivery with an acknowledgement that stays pending until the test releases it.
function startDelivery(ownsNavigation) {
  const ack = deferred();
  const calls = [];
  const pending = acknowledgeConnectOnboardingBeforeNavigation(
    link,
    async (receipt) => {
      await ack.promise;
      calls.push(["ack", receipt]);
    },
    (url) => calls.push(["navigate", url]),
    ownsNavigation,
  );
  return {
    calls,
    finish() {
      ack.resolve();
      return pending;
    },
  };
}

test("compares the signed-in user and active studio", () => {
  assert.equal(isSameConnectOnboardingOwner(owner, { ...owner }), true);
  assert.equal(isSameConnectOnboardingOwner(owner, { ...owner, userId: "user-2" }), false);
  assert.equal(isSameConnectOnboardingOwner(owner, { ...owner, studioId: "studio-2" }), false);
  assert.equal(isSameConnectOnboardingOwner(owner, null), false);
});

test("refresh route navigates after acknowledgement for the same mounted owner", async () => {
  const delivery = startDelivery(
    ownsConnectOnboardingNavigation(
      owner,
      () => true,
      async () => ({ ...owner }),
    ),
  );
  assert.equal(await delivery.finish(), true);
  assert.deepEqual(delivery.calls, [
    ["ack", "receipt"],
    ["navigate", link.pending_url],
  ]);
});

test("refresh route does not navigate after it unmounts during acknowledgement", async () => {
  let mounted = true;
  const delivery = startDelivery(
    ownsConnectOnboardingNavigation(
      owner,
      () => mounted,
      async () => ({ ...owner }),
    ),
  );
  mounted = false;
  assert.equal(await delivery.finish(), false);
  assert.deepEqual(delivery.calls, [["ack", "receipt"]]);
});

test("refresh route does not navigate after the signed-in user or studio changes", async () => {
  for (const current of [
    { ...owner, userId: "user-2" },
    { ...owner, studioId: "studio-2" },
    null,
  ]) {
    const delivery = startDelivery(
      ownsConnectOnboardingNavigation(
        owner,
        () => true,
        async () => current,
      ),
    );
    assert.equal(await delivery.finish(), false);
    assert.deepEqual(delivery.calls, [["ack", "receipt"]]);
  }
});

test("refresh route does not navigate when it unmounts while identity is rechecked", async () => {
  let mounted = true;
  const identity = deferred();
  const delivery = startDelivery(
    ownsConnectOnboardingNavigation(
      owner,
      () => mounted,
      () => identity.promise,
    ),
  );
  const pending = delivery.finish();
  await new Promise((resolve) => setImmediate(resolve));
  mounted = false;
  identity.resolve({ ...owner });
  assert.equal(await pending, false);
  assert.deepEqual(delivery.calls, [["ack", "receipt"]]);
});

test("billing onboarding navigates after acknowledgement for the current owner", async () => {
  const tracker = createConnectOnboardingOwnerTracker();
  tracker.enter("user-1:studio-1:admin:1");
  const delivery = startDelivery(tracker.begin());
  assert.equal(await delivery.finish(), true);
  assert.deepEqual(delivery.calls, [
    ["ack", "receipt"],
    ["navigate", link.pending_url],
  ]);
});

test("billing onboarding does not navigate after the page exits", async () => {
  const tracker = createConnectOnboardingOwnerTracker();
  tracker.enter("user-1:studio-1:admin:1");
  const delivery = startDelivery(tracker.begin());
  tracker.leave();
  assert.equal(await delivery.finish(), false);
  assert.deepEqual(delivery.calls, [["ack", "receipt"]]);
});

test("billing onboarding does not navigate after the identity changes", async () => {
  const tracker = createConnectOnboardingOwnerTracker();
  tracker.enter("user-1:studio-1:admin:1");
  const delivery = startDelivery(tracker.begin());
  tracker.leave();
  tracker.enter("user-1:studio-2:admin:2");
  assert.equal(await delivery.finish(), false);
  assert.deepEqual(delivery.calls, [["ack", "receipt"]]);
});

test("billing onboarding does not navigate after leaving and returning to the same identity", async () => {
  const tracker = createConnectOnboardingOwnerTracker();
  tracker.enter("user-1:studio-1:admin:1");
  const delivery = startDelivery(tracker.begin());
  tracker.leave();
  tracker.enter("user-1:studio-1:admin:1");
  assert.equal(await delivery.finish(), false);
  assert.deepEqual(delivery.calls, [["ack", "receipt"]]);
});

test("billing onboarding does not navigate for a superseded action", async () => {
  const tracker = createConnectOnboardingOwnerTracker();
  tracker.enter("user-1:studio-1:admin:1");
  const first = startDelivery(tracker.begin());
  const second = startDelivery(tracker.begin());
  assert.equal(await first.finish(), false);
  assert.deepEqual(first.calls, [["ack", "receipt"]]);
  assert.equal(await second.finish(), true);
  assert.deepEqual(second.calls, [
    ["ack", "receipt"],
    ["navigate", link.pending_url],
  ]);
});

test("billing onboarding cannot begin without a verified owner", () => {
  const tracker = createConnectOnboardingOwnerTracker();
  assert.equal(tracker.begin(), null);
  tracker.enter(null);
  assert.equal(tracker.begin(), null);
});

test("both live onboarding callers pass an ownership guard", () => {
  const refresh = readFileSync(
    new URL("../src/app/billing/connect/refresh/page.tsx", import.meta.url),
    "utf8",
  );
  const actions = readFileSync(
    new URL("../src/lib/billing-connect-actions.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    refresh,
    /acknowledgeConnectOnboardingBeforeNavigation\([\s\S]*ownsConnectOnboardingNavigation\(/,
  );
  assert.match(
    actions,
    /acknowledgeConnectOnboardingBeforeNavigation\([\s\S]*ownsNavigation,\s*\)/,
  );
});
