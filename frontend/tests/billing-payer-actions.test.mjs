import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { executePayerAutopaySetup } from "../src/lib/billing-payer-setup-action.ts";
import { buildPayerOperationStorageKey } from "../src/lib/billing-payer-setup-model.ts";

const identity = { userId: "user-1", studioId: "studio-1" };

function payer(overrides = {}) {
  return {
    id: "payer-1",
    autopay_status: "enabled",
    stripe_payment_method_id: "pm-old",
    updated_at: "2026-08-30T00:00:00Z",
    ...overrides,
  };
}

function memoryStorage(initialKey) {
  const values = new Map();
  const key = buildPayerOperationStorageKey(identity, "payer-1", "payer.setup");
  if (initialKey) values.set(key, initialKey);
  return {
    key,
    values,
    getItem: (itemKey) => values.get(itemKey) ?? null,
    removeItem: (itemKey) => values.delete(itemKey),
    setItem: (itemKey, value) => values.set(itemKey, value),
  };
}

function runtime() {
  let active = null;
  const errors = [];
  const messages = [];
  return {
    runtime: {
      canUseWorkflow: () => true,
      claimAction(action) {
        if (active) return false;
        active = action;
        return true;
      },
      isPreviewMode: false,
      releaseAction(action) {
        if (active === action) active = null;
      },
      setError: (message) => errors.push(message),
      setMessage: (message) => messages.push(message),
      token: "token-1",
    },
    errors,
    messages,
  };
}

function requestKey(calls) {
  return calls.at(-1)[3].headers["Idempotency-Key"];
}

describe("payer setup action", () => {
  it("claims before rotating and ignores a concurrent second click", async () => {
    const storage = memoryStorage("completed-key");
    const holder = runtime();
    const calls = [];
    let resolvePost;
    const post = (...args) => {
      calls.push(args);
      return new Promise((resolve) => { resolvePost = resolve; });
    };
    let sequence = 0;
    const options = {
      attemptsByPayer: new Map(),
      copyLink: async () => true,
      createKey: () => `replacement-${++sequence}`,
      identity,
      keysByPayer: new Map(),
      origin: "https://app.koaryu.test",
      payer: payer(),
      post,
      runtime: holder.runtime,
      storage,
    };
    const first = executePayerAutopaySetup(options);
    const second = await executePayerAutopaySetup(options);
    assert.equal(second, null);
    assert.equal(calls.length, 1);
    assert.equal(requestKey(calls), "replacement-1");
    assert.equal(sequence, 1);
    resolvePost({ url: "https://checkout.stripe.test/setup" });
    assert.equal(await first, "https://checkout.stripe.test/setup");
  });

  it("reuses the sent replacement key after an ambiguous failure and after a usable link", async () => {
    const storage = memoryStorage("completed-key");
    const keysByPayer = new Map();
    const calls = [];
    let sequence = 0;
    const common = {
      attemptsByPayer: new Map(),
      copyLink: async () => true,
      createKey: () => `replacement-${++sequence}`,
      identity,
      keysByPayer,
      origin: "https://app.koaryu.test",
      payer: payer(),
      runtime: runtime().runtime,
      storage,
    };
    await executePayerAutopaySetup({
      ...common,
      post: async (...args) => {
        calls.push(args);
        throw Object.assign(new Error("Provider outcome is ambiguous."), { status: 503 });
      },
    });
    await executePayerAutopaySetup({
      ...common,
      runtime: runtime().runtime,
      post: async (...args) => {
        calls.push(args);
        return { url: "https://checkout.stripe.test/setup" };
      },
    });
    await executePayerAutopaySetup({
      ...common,
      runtime: runtime().runtime,
      post: async (...args) => {
        calls.push(args);
        return { url: "https://checkout.stripe.test/setup" };
      },
    });
    assert.deepEqual(calls.map((call) => call[3].headers["Idempotency-Key"]), [
      "replacement-1",
      "replacement-1",
      "replacement-1",
    ]);
    assert.equal(sequence, 1);
  });

  it("rotates after terminal rejection and after authoritative payer completion changes", async () => {
    const storage = memoryStorage("completed-key");
    const keysByPayer = new Map();
    const calls = [];
    let sequence = 0;
    const attemptsByPayer = new Map();
    const run = (payerSnapshot, post) => executePayerAutopaySetup({
      attemptsByPayer,
      copyLink: async () => true,
      createKey: () => `replacement-${++sequence}`,
      identity,
      keysByPayer,
      origin: "https://app.koaryu.test",
      payer: payerSnapshot,
      post: async (...args) => {
        calls.push(args);
        return post();
      },
      runtime: runtime().runtime,
      storage,
    });
    await run(payer(), () => {
      throw Object.assign(
        new Error("The Stripe autopay setup session expired. Start a new setup with a new Idempotency-Key."),
        { status: 409 },
      );
    });
    await run(payer(), () => ({ url: "https://checkout.stripe.test/replacement-2" }));
    await run(
      payer({ stripe_payment_method_id: "pm-new", updated_at: "2026-08-30T01:00:00Z" }),
      () => ({ url: "https://checkout.stripe.test/replacement-3" }),
    );
    assert.deepEqual(calls.map((call) => call[3].headers["Idempotency-Key"]), [
      "replacement-1",
      "replacement-2",
      "replacement-3",
    ]);
  });

  it("preserves pending setup and the public return URL", async () => {
    const storage = memoryStorage("pending-key");
    const calls = [];
    await executePayerAutopaySetup({
      attemptsByPayer: new Map(),
      copyLink: async () => true,
      createKey: () => assert.fail("pending setup rotated"),
      identity,
      keysByPayer: new Map(),
      origin: "https://app.koaryu.test",
      payer: payer({ autopay_status: "pending", stripe_payment_method_id: null }),
      post: async (...args) => {
        calls.push(args);
        return { url: "https://checkout.stripe.test/pending" };
      },
      runtime: runtime().runtime,
      storage,
    });
    assert.equal(requestKey(calls), "pending-key");
    assert.deepEqual(calls[0][1], {
      return_url: "https://app.koaryu.test/payer-setup-complete",
    });
  });

  it("reuses one in-memory replacement key when storage is absent, throwing, or a no-op", async () => {
    for (const storage of [
      undefined,
      {
        getItem() { throw new Error("blocked"); },
        removeItem() { throw new Error("blocked"); },
        setItem() { throw new Error("blocked"); },
      },
      {
        getItem() { return "completed-key"; },
        removeItem() {},
        setItem() {},
      },
    ]) {
      const attemptsByPayer = new Map();
      const keysByPayer = new Map();
      const calls = [];
      let sequence = 0;
      const run = () => executePayerAutopaySetup({
        attemptsByPayer,
        copyLink: async () => true,
        createKey: () => `fallback-${++sequence}`,
        identity,
        keysByPayer,
        origin: "https://app.koaryu.test",
        payer: payer(),
        post: async (...args) => {
          calls.push(args);
          throw Object.assign(new Error("Provider outcome is ambiguous."), { status: 503 });
        },
        runtime: runtime().runtime,
        storage,
      });
      await run();
      await run();
      assert.deepEqual(calls.map((call) => call[3].headers["Idempotency-Key"]), [
        "fallback-1",
        "fallback-1",
      ]);
      assert.equal(sequence, 1);
    }
  });

  it("ignores unrelated updated_at changes but rotates after setup authorization changes", async () => {
    const storage = memoryStorage("completed-key");
    const attemptsByPayer = new Map();
    const keysByPayer = new Map();
    const calls = [];
    let sequence = 0;
    const run = (payerSnapshot) => executePayerAutopaySetup({
      attemptsByPayer,
      copyLink: async () => true,
      createKey: () => `baseline-${++sequence}`,
      identity,
      keysByPayer,
      origin: "https://app.koaryu.test",
      payer: payerSnapshot,
      post: async (...args) => {
        calls.push(args);
        return { url: "https://checkout.stripe.test/setup" };
      },
      runtime: runtime().runtime,
      storage,
    });
    await run(payer({ updated_at: "2026-08-30T00:00:00Z" }));
    await run(payer({ updated_at: "2026-08-30T02:00:00Z" }));
    await run(payer({
      autopay_authorized_at: "2026-08-30T03:00:00Z",
      stripe_payment_method_id: "pm-new",
      updated_at: "2026-08-30T03:00:00Z",
    }));
    assert.deepEqual(calls.map((call) => call[3].headers["Idempotency-Key"]), [
      "baseline-1",
      "baseline-1",
      "baseline-2",
    ]);
  });

  it("prefers sent in-memory B over stale valid durable A after a no-op write", async () => {
    const storage = memoryStorage("completed-key");
    const attemptsByPayer = new Map();
    const keysByPayer = new Map();
    const calls = [];
    let sequence = 0;
    const run = (payerSnapshot, activeStorage, shouldFail = false) => executePayerAutopaySetup({
      attemptsByPayer,
      copyLink: async () => true,
      createKey: () => `coherent-${++sequence}`,
      identity,
      keysByPayer,
      origin: "https://app.koaryu.test",
      payer: payerSnapshot,
      post: async (...args) => {
        calls.push(args);
        if (shouldFail) {
          throw Object.assign(new Error("Provider outcome is ambiguous."), { status: 503 });
        }
        return { url: "https://checkout.stripe.test/setup" };
      },
      runtime: runtime().runtime,
      storage: activeStorage,
    });
    await run(payer(), storage);
    const durableA = storage.values.get(storage.key);
    const noOpWriteStorage = {
      getItem: () => durableA,
      removeItem: storage.removeItem,
      setItem() {},
    };
    const changedSetup = payer({
      autopay_authorized_at: "2026-08-30T03:00:00Z",
      stripe_payment_method_id: "pm-new",
    });
    await run(changedSetup, noOpWriteStorage, true);
    await run(changedSetup, noOpWriteStorage, true);
    assert.deepEqual(calls.map((call) => call[3].headers["Idempotency-Key"]), [
      "coherent-1",
      "coherent-2",
      "coherent-2",
    ]);
    assert.equal(sequence, 2, "retry must not mint unsent C");
  });

  it("fails closed when terminal cleanup cannot remove a valid durable attempt", async () => {
    const storage = memoryStorage("completed-key");
    const attemptsByPayer = new Map();
    const keysByPayer = new Map();
    const calls = [];
    const holder = runtime();
    let sequence = 0;
    const common = {
      attemptsByPayer,
      copyLink: async () => true,
      createKey: () => `terminal-${++sequence}`,
      identity,
      keysByPayer,
      origin: "https://app.koaryu.test",
      payer: payer(),
    };
    await executePayerAutopaySetup({
      ...common,
      post: async () => ({ url: "https://checkout.stripe.test/setup" }),
      runtime: runtime().runtime,
      storage,
    });
    const noOpRemoveStorage = {
      getItem: storage.getItem,
      removeItem() {},
      setItem: storage.setItem,
    };
    await executePayerAutopaySetup({
      ...common,
      post: async (...args) => {
        calls.push(args);
        throw Object.assign(
          new Error("The Stripe autopay setup session expired. Start a new setup with a new Idempotency-Key."),
          { status: 409 },
        );
      },
      runtime: holder.runtime,
      storage: noOpRemoveStorage,
    });
    await executePayerAutopaySetup({
      ...common,
      post: async (...args) => {
        calls.push(args);
        return { url: "https://checkout.stripe.test/must-not-send" };
      },
      runtime: holder.runtime,
      storage: noOpRemoveStorage,
    });
    assert.equal(calls.length, 1, "fail-closed retry must not POST");
    assert.equal(sequence, 1, "fail-closed retry must not mint a replacement");
    assert.match(holder.errors.at(-1), /could not be cleared from this browser/i);
  });

  it("fails closed when storage becomes unavailable during terminal cleanup", async () => {
    const durable = memoryStorage("completed-key");
    const attemptsByPayer = new Map();
    const keysByPayer = new Map();
    const calls = [];
    const holder = runtime();
    let sequence = 0;
    let accessible = true;
    const changingStorage = {
      getItem(key) {
        if (!accessible) throw new Error("storage unavailable");
        return durable.getItem(key);
      },
      removeItem(key) {
        if (!accessible) throw new Error("storage unavailable");
        durable.removeItem(key);
      },
      setItem(key, value) {
        if (!accessible) throw new Error("storage unavailable");
        durable.setItem(key, value);
      },
    };
    const common = {
      attemptsByPayer,
      copyLink: async () => true,
      createKey: () => `unavailable-${++sequence}`,
      identity,
      keysByPayer,
      origin: "https://app.koaryu.test",
      payer: payer(),
      runtime: holder.runtime,
      storage: changingStorage,
    };
    await executePayerAutopaySetup({
      ...common,
      post: async () => ({ url: "https://checkout.stripe.test/setup" }),
    });
    const staleDurableAttempt = durable.values.get(durable.key);
    await executePayerAutopaySetup({
      ...common,
      post: async (...args) => {
        calls.push(args);
        accessible = false;
        throw Object.assign(
          new Error("The Stripe autopay setup session expired. Start a new setup with a new Idempotency-Key."),
          { status: 409 },
        );
      },
    });
    assert.match(holder.errors.at(-1), /could not be cleared from this browser/i);
    assert.equal(durable.values.get(durable.key), staleDurableAttempt);

    accessible = true;
    await executePayerAutopaySetup({
      ...common,
      post: async (...args) => {
        calls.push(args);
        return { url: "https://checkout.stripe.test/must-not-send" };
      },
    });
    assert.equal(calls.length, 1, "restored stale storage must remain blocked");
    assert.equal(sequence, 1, "blocked retry must not mint another key");
    assert.equal(durable.values.get(durable.key), staleDurableAttempt);
  });
});
