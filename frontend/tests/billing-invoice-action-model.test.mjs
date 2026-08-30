import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildInvoiceOperationRequest,
  clearPersistedInvoiceOperationRequestKey,
  clearInvoiceRetryRequestKey,
  clearPersistedInvoiceRetryRequestKey,
  getOrCreateInvoiceRetryRequestKey,
  getOrCreatePersistedInvoiceRetryRequestKey,
  invoiceDraftFingerprint,
  resolvePersistedInvoiceOperationRequestKey,
  shouldRetainInvoiceRetryRequestKey,
} from "../src/lib/billing-invoice-action-model.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function blockedStorage() {
  return {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
}


describe("billing invoice retry request keys", () => {
  it("reuses the same key when a retry response is lost", () => {
    const keys = new Map();
    let sequence = 0;
    const createKey = () => `operation-${++sequence}`;

    const firstAttempt = getOrCreateInvoiceRetryRequestKey(keys, "invoice-1", createKey);
    const retryAfterLostResponse = getOrCreateInvoiceRetryRequestKey(keys, "invoice-1", createKey);

    assert.equal(firstAttempt, "operation-1");
    assert.equal(retryAfterLostResponse, firstAttempt);
    assert.equal(sequence, 1);
  });

  it("uses separate keys for concurrent invoices and after a completed operation", () => {
    const keys = new Map();
    let sequence = 0;
    const createKey = () => `operation-${++sequence}`;

    const firstInvoice = getOrCreateInvoiceRetryRequestKey(keys, "invoice-1", createKey);
    const secondInvoice = getOrCreateInvoiceRetryRequestKey(keys, "invoice-2", createKey);
    clearInvoiceRetryRequestKey(keys, "invoice-1");
    const laterFirstInvoiceRetry = getOrCreateInvoiceRetryRequestKey(keys, "invoice-1", createKey);

    assert.notEqual(firstInvoice, secondInvoice);
    assert.notEqual(firstInvoice, laterFirstInvoiceRetry);
    assert.equal(getOrCreateInvoiceRetryRequestKey(keys, "invoice-2", createKey), secondInvoice);
  });

  it("preserves ambiguous timeout and server-failure attempts", () => {
    assert.equal(shouldRetainInvoiceRetryRequestKey(null), true);
    assert.equal(shouldRetainInvoiceRetryRequestKey(500), true);
    assert.equal(shouldRetainInvoiceRetryRequestKey(503), true);
  });

  it("retains every unconfirmed response until deliberate key rotation", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const createKey = () => `operation-${++sequence}`;
    const first = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-1", "invoice-1", createKey, storage
    );

    assert.equal(shouldRetainInvoiceRetryRequestKey(402), true);
    clearPersistedInvoiceRetryRequestKey("user-1:studio-1", "invoice-1", storage);
    const corrected = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-1", "invoice-1", createKey, storage
    );

    assert.notEqual(corrected, first);
  });

  it("persists exact retry identity and rotates only when explicitly requested", () => {
    const storage = memoryStorage();
    const memory = new Map();
    let sequence = 0;
    const options = {
      createKey: () => `retry-key-${++sequence}`,
      identity: { userId: "user-1", studioId: "studio-1" },
      keysByTarget: memory,
      operation: "invoice.retry",
      storage,
      targetId: "invoice-1",
    };

    const first = resolvePersistedInvoiceOperationRequestKey(options);
    memory.clear();
    const afterReload = resolvePersistedInvoiceOperationRequestKey(options);
    const rotated = resolvePersistedInvoiceOperationRequestKey({
      ...options,
      startNewRequest: true,
    });

    assert.equal(afterReload, first);
    assert.notEqual(rotated, first);
    assert.deepEqual(buildInvoiceOperationRequest(rotated), {
      headers: { "Idempotency-Key": rotated },
    });
  });

  it("scopes retry keys by exact user, studio, and invoice", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const keyFor = (userId, studioId, targetId) => (
      resolvePersistedInvoiceOperationRequestKey({
        createKey: () => `key-${++sequence}`,
        identity: { userId, studioId },
        keysByTarget: new Map(),
        operation: "invoice.retry",
        storage,
        targetId,
      })
    );

    const base = keyFor("user-1", "studio-1", "invoice-1");
    assert.notEqual(keyFor("user-2", "studio-1", "invoice-1"), base);
    assert.notEqual(keyFor("user-1", "studio-2", "invoice-1"), base);
    assert.notEqual(keyFor("user-1", "studio-1", "invoice-2"), base);
  });

  it("keeps finalize and void keys separate across reload", () => {
    const storage = memoryStorage();
    const identity = { userId: "admin-1", studioId: "studio-1" };
    let sequence = 0;
    const resolve = (operation, memory = new Map()) => (
      resolvePersistedInvoiceOperationRequestKey({
        createKey: () => `invoice-key-${++sequence}`,
        identity,
        keysByTarget: memory,
        operation,
        storage,
        targetId: "invoice-1",
      })
    );

    const finalizeKey = resolve("invoice.finalize");
    const finalizeReload = resolve("invoice.finalize");
    const voidKey = resolve("invoice.void");

    assert.equal(finalizeReload, finalizeKey);
    assert.notEqual(voidKey, finalizeKey);
    assert.deepEqual(buildInvoiceOperationRequest(voidKey), {
      headers: { "Idempotency-Key": voidKey },
    });
  });

  it("uses a normalized draft fingerprint for create keys across reload", () => {
    const firstPayload = {
      payer_id: "payer-1",
      amount_cents: 5000,
      currency: "usd",
      items: [{ description: "Tuition", amount_cents: 5000 }],
    };
    const equivalentPayload = {
      items: [{ amount_cents: 5000, description: "Tuition" }],
      currency: "usd",
      amount_cents: 5000,
      payer_id: "payer-1",
    };
    const changedPayload = { ...firstPayload, amount_cents: 5100 };
    assert.equal(
      invoiceDraftFingerprint(firstPayload),
      invoiceDraftFingerprint(equivalentPayload),
    );
    assert.notEqual(
      invoiceDraftFingerprint(firstPayload),
      invoiceDraftFingerprint(changedPayload),
    );

    const storage = memoryStorage();
    const identity = { userId: "user-1", studioId: "studio-1" };
    const targetId = invoiceDraftFingerprint(firstPayload);
    let sequence = 0;
    const createKey = () => `create-key-${++sequence}`;
    const beforeReload = resolvePersistedInvoiceOperationRequestKey({
      createKey,
      identity,
      keysByTarget: new Map(),
      operation: "invoice.create",
      storage,
      targetId,
    });
    const afterReload = resolvePersistedInvoiceOperationRequestKey({
      createKey,
      identity,
      keysByTarget: new Map(),
      operation: "invoice.create",
      storage,
      targetId,
    });
    assert.equal(afterReload, beforeReload);
    assert.equal(sequence, 1);
  });

  it("keeps an exact scoped key when browser storage is blocked", () => {
    const memory = new Map();
    let sequence = 0;
    const options = {
      createKey: () => `key-${++sequence}`,
      identity: { userId: "user-1", studioId: "studio-1" },
      keysByTarget: memory,
      operation: "invoice.retry",
      storage: blockedStorage(),
      targetId: "invoice-1",
    };
    const first = resolvePersistedInvoiceOperationRequestKey(options);
    const replay = resolvePersistedInvoiceOperationRequestKey(options);
    assert.equal(replay, first);
    assert.equal(sequence, 1);
  });

  it("wires exact identity and stable operation headers into capability-gated controls", () => {
    const pageController = fs.readFileSync(
      path.join(root, "src/lib/billing-page-controller.ts"),
      "utf8",
    );
    const invoiceController = fs.readFileSync(
      path.join(root, "src/lib/billing-invoice-controller.ts"),
      "utf8",
    );
    const invoiceTab = fs.readFileSync(
      path.join(root, "src/components/billing/billing-invoices-tab.tsx"),
      "utf8",
    );
    const model = fs.readFileSync(
      path.join(root, "src/lib/billing-invoice-action-model.ts"),
      "utf8",
    );

    assert.match(pageController, /operationIdentity: currentUserId && currentStudioId/);
    assert.match(invoiceController, /operation: `invoice\.\$\{action\}`/);
    assert.match(invoiceController, /buildInvoiceOperationRequest\(requestKey\)/);
    assert.match(
      invoiceController,
      /await api\.post[\s\S]*?clearPersistedInvoiceOperationRequestKey/,
    );
    for (const action of ["finalize", "retry", "void"]) {
      assert.match(invoiceTab, new RegExp(`canUseWorkflow\\("invoice\\.${action}"\\)`));
      assert.match(invoiceTab, new RegExp(`onInvoiceAction\\(invoice\\.id, "${action}"\\)`));
    }
    assert.match(invoiceTab, /window\.confirm\("Void this invoice\?/);
    assert.doesNotMatch(model, /\btoken\b|authorization/i);
  });

  it("clears a confirmed operation from memory and storage", () => {
    const storage = memoryStorage();
    const memory = new Map();
    const options = {
      identity: { userId: "user-1", studioId: "studio-1" },
      keysByTarget: memory,
      operation: "invoice.retry",
      storage,
      targetId: "invoice-1",
    };
    const first = resolvePersistedInvoiceOperationRequestKey({
      ...options,
      createKey: () => "key-1",
    });
    clearPersistedInvoiceOperationRequestKey(options);
    const next = resolvePersistedInvoiceOperationRequestKey({
      ...options,
      createKey: () => "key-2",
    });
    assert.equal(first, "key-1");
    assert.equal(next, "key-2");
  });

  it("replays the same ambiguous operation after a page reload", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const createKey = () => `operation-${++sequence}`;
    const beforeReload = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-1", "invoice-1", createKey, storage
    );
    const afterReload = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-1", "invoice-1", createKey, storage
    );

    assert.equal(afterReload, beforeReload);
    assert.equal(sequence, 1);
  });

  it("scopes persisted retry operations by user, studio, and invoice", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const createKey = () => `operation-${++sequence}`;

    const studioOne = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-1", "invoice-1", createKey, storage
    );
    const studioTwo = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-2", "invoice-1", createKey, storage
    );
    const otherInvoice = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-1", "invoice-2", createKey, storage
    );
    const otherUser = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-2:studio-1", "invoice-1", createKey, storage
    );

    assert.notEqual(studioOne, studioTwo);
    assert.notEqual(studioOne, otherInvoice);
    assert.notEqual(studioOne, otherUser);
  });

  it("keeps one in-memory operation key when browser storage is blocked", () => {
    const fallback = new Map();
    let sequence = 0;
    const createKey = () => `operation-${++sequence}`;

    const first = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-1", "invoice-1", createKey, blockedStorage(), fallback
    );
    const second = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-1", "invoice-1", createKey, blockedStorage(), fallback
    );

    assert.equal(second, first);
    assert.equal(sequence, 1);
  });

  it("falls back when reading browser storage itself is blocked", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const fallback = new Map();
    let sequence = 0;
    const createKey = () => `operation-${++sequence}`;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access denied", "SecurityError");
      },
    });

    try {
      const first = getOrCreatePersistedInvoiceRetryRequestKey(
        "user-1:studio-1", "invoice-1", createKey, undefined, fallback
      );
      const second = getOrCreatePersistedInvoiceRetryRequestKey(
        "user-1:studio-1", "invoice-1", createKey, undefined, fallback
      );

      assert.equal(second, first);
      assert.equal(sequence, 1);
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        delete globalThis.window;
      }
    }
  });
});
