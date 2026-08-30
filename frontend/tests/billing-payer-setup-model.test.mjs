import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPayerAutopaySetupRequest,
  buildPayerOperationStorageKey,
  buildPayerSyncRequest,
  clearPersistedPayerOperationRequestKey,
  copyPayerAutopaySetupLink,
  getPayerAutopaySetupReturnUrl,
  resolvePersistedPayerOperationRequestKey,
  resolvePayerAutopaySetupRequestKey,
  resolvePayerSyncRequestKey,
} from "../src/lib/billing-payer-setup-model.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("hidden payer autopay setup adapter", () => {
  it("sends a caller-owned key without staff consent assertion", () => {
    const request = buildPayerAutopaySetupRequest(
      "https://app.koaryu.test/billing",
      "payer-setup-key-1",
    );

    assert.deepEqual(request, {
      body: { return_url: "https://app.koaryu.test/billing" },
      headers: { "Idempotency-Key": "payer-setup-key-1" },
    });
    assert.doesNotMatch(JSON.stringify(request), /terms_accepted/i);
  });

  it("returns payers to a public completion route instead of staff billing", () => {
    assert.equal(
      getPayerAutopaySetupReturnUrl("https://app.koaryu.test/billing?tab=families"),
      "https://app.koaryu.test/payer-setup-complete",
    );
    const actions = fs.readFileSync(path.join(root, "src/lib/billing-payer-actions.ts"), "utf8");
    const proxy = fs.readFileSync(path.join(root, "src/proxy.ts"), "utf8");
    assert.match(actions, /getPayerAutopaySetupReturnUrl\(window\.location\.origin\)/);
    assert.doesNotMatch(proxy, /payer-setup-complete/);
    assert.equal(
      fs.existsSync(path.join(root, "src/app/payer-setup-complete/page.tsx")),
      true,
    );
  });

  it("reuses one payer key for retries and rotates only for a deliberate new setup", () => {
    const keys = new Map();
    const generated = ["key-1", "key-2"];
    const createKey = () => generated.shift();

    assert.equal(resolvePayerAutopaySetupRequestKey(keys, "payer-1", false, createKey), "key-1");
    assert.equal(resolvePayerAutopaySetupRequestKey(keys, "payer-1", false, createKey), "key-1");
    assert.equal(resolvePayerAutopaySetupRequestKey(keys, "payer-1", true, createKey), "key-2");
  });

  it("copies the payer link and never navigates the staff browser", async () => {
    const copied = [];
    assert.equal(
      await copyPayerAutopaySetupLink(
        "https://checkout.stripe.test/setup",
        async (value) => copied.push(value),
      ),
      true,
    );
    assert.deepEqual(copied, ["https://checkout.stripe.test/setup"]);

    const source = fs.readFileSync(
      path.join(root, "src/lib/billing-payer-actions.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /window\.confirm|terms_accepted|location\.assign/);
  });

  it("keeps one caller-owned payer sync key until a deliberate new sync", () => {
    const keys = new Map();
    const generated = ["sync-key-1", "sync-key-2"];
    const createKey = () => generated.shift();

    const first = resolvePayerSyncRequestKey(keys, "payer-1", false, createKey);
    const replay = resolvePayerSyncRequestKey(keys, "payer-1", false, createKey);
    const fresh = resolvePayerSyncRequestKey(keys, "payer-1", true, createKey);

    assert.deepEqual(buildPayerSyncRequest(first), {
      headers: { "Idempotency-Key": "sync-key-1" },
    });
    assert.equal(replay, first);
    assert.equal(fresh, "sync-key-2");

    const source = fs.readFileSync(
      path.join(root, "src/lib/billing-payer-actions.ts"),
      "utf8",
    );
    assert.match(source, /resolvePersistedPayerOperationRequestKey/);
    assert.match(source, /requestOptions: \{ headers: request\.headers \}/);
  });

  it("restores payer setup and sync keys after reload within the exact scope", () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value),
    };
    const identity = { userId: "user-1", studioId: "studio-1" };
    const generated = ["setup-key", "sync-key"];
    const createKey = () => generated.shift();

    const setup = resolvePersistedPayerOperationRequestKey({
      createKey,
      identity,
      keysByPayer: new Map(),
      operation: "payer.setup",
      payerId: "payer-1",
      storage,
    });
    const sync = resolvePersistedPayerOperationRequestKey({
      createKey,
      identity,
      keysByPayer: new Map(),
      operation: "payer.sync",
      payerId: "payer-1",
      storage,
    });

    assert.equal(
      resolvePersistedPayerOperationRequestKey({
        createKey: () => assert.fail("reload generated another setup key"),
        identity,
        keysByPayer: new Map(),
        operation: "payer.setup",
        payerId: "payer-1",
        storage,
      }),
      setup,
    );
    assert.equal(
      resolvePersistedPayerOperationRequestKey({
        createKey: () => assert.fail("reload generated another sync key"),
        identity,
        keysByPayer: new Map(),
        operation: "payer.sync",
        payerId: "payer-1",
        storage,
      }),
      sync,
    );
  });

  it("reopens a usable payer setup session with its original key after reload", () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value),
    };
    const options = {
      identity: { userId: "user-1", studioId: "studio-1" },
      operation: "payer.setup",
      payerId: "payer-1",
      storage,
    };

    const first = resolvePersistedPayerOperationRequestKey({
      ...options,
      createKey: () => "setup-key",
      keysByPayer: new Map(),
    });
    const reopened = resolvePersistedPayerOperationRequestKey({
      ...options,
      createKey: () => assert.fail("reopen generated another setup key"),
      keysByPayer: new Map(),
    });

    assert.equal(reopened, first);

    const source = fs.readFileSync(
      path.join(root, "src/lib/billing-payer-actions.ts"),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /if \(link\?\.url\) \{\s*clearPersistedPayerOperationRequestKey/s,
    );
  });

  it("separates persisted keys by user, studio, payer, and operation", () => {
    const scopes = [
      [{ userId: "user-1", studioId: "studio-1" }, "payer-1", "payer.sync"],
      [{ userId: "user-2", studioId: "studio-1" }, "payer-1", "payer.sync"],
      [{ userId: "user-1", studioId: "studio-2" }, "payer-1", "payer.sync"],
      [{ userId: "user-1", studioId: "studio-1" }, "payer-2", "payer.sync"],
      [{ userId: "user-1", studioId: "studio-1" }, "payer-1", "payer.setup"],
    ];
    const keys = scopes.map(([identity, payerId, operation]) =>
      buildPayerOperationStorageKey(identity, payerId, operation),
    );
    assert.equal(new Set(keys).size, scopes.length);
    assert.equal(
      buildPayerOperationStorageKey(
        { userId: "x".repeat(161), studioId: "studio-1" },
        "payer-1",
        "payer.sync",
      ),
      null,
    );
  });

  it("clears sync persistence only through confirmed-success handling", () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value),
    };
    const identity = { userId: "user-1", studioId: "studio-1" };
    const memory = new Map();
    resolvePersistedPayerOperationRequestKey({
      createKey: () => "sync-key",
      identity,
      keysByPayer: memory,
      operation: "payer.sync",
      payerId: "payer-1",
      storage,
    });
    assert.equal(values.size, 1);

    clearPersistedPayerOperationRequestKey({
      identity,
      keysByPayer: memory,
      operation: "payer.sync",
      payerId: "payer-1",
      storage,
    });
    assert.equal(values.size, 0);
    assert.equal(memory.size, 0);

    const source = fs.readFileSync(
      path.join(root, "src/lib/billing-payer-actions.ts"),
      "utf8",
    );
    assert.match(
      source,
      /if \(result\) \{\s*clearPersistedPayerOperationRequestKey/s,
    );
  });

  it("keeps a scoped in-memory key when browser storage is blocked", () => {
    const blockedStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const memory = new Map();
    const options = {
      identity: { userId: "user-1", studioId: "studio-1" },
      keysByPayer: memory,
      operation: "payer.sync",
      payerId: "payer-1",
      storage: blockedStorage,
    };
    const first = resolvePersistedPayerOperationRequestKey({
      ...options,
      createKey: () => "sync-key",
    });
    const retry = resolvePersistedPayerOperationRequestKey({
      ...options,
      createKey: () => assert.fail("blocked storage replaced the memory key"),
    });
    assert.equal(retry, first);
  });

  it("wires user and studio identity through the controller without persisting tokens", () => {
    const pageController = fs.readFileSync(
      path.join(root, "src/lib/billing-page-controller.ts"),
      "utf8",
    );
    const actionController = fs.readFileSync(
      path.join(root, "src/lib/billing-action-controller.ts"),
      "utf8",
    );
    const model = fs.readFileSync(
      path.join(root, "src/lib/billing-payer-setup-model.ts"),
      "utf8",
    );

    assert.match(pageController, /currentUserId && currentStudioId/);
    assert.match(
      pageController,
      /\{ userId: currentUserId, studioId: currentStudioId \}/,
    );
    assert.match(
      actionController,
      /useBillingPayerActions\(runtime, payerOperationIdentity\)/,
    );
    assert.doesNotMatch(model, /\btoken\b|authorization/i);
  });
});
