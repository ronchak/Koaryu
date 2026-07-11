import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearInvoiceRetryRequestKey,
  clearPersistedInvoiceRetryRequestKey,
  getOrCreateInvoiceRetryRequestKey,
  getOrCreatePersistedInvoiceRetryRequestKey,
  shouldRetainInvoiceRetryRequestKey,
} from "../src/lib/billing-invoice-action-model.ts";

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

  it("clears definitive client failures so a corrected retry receives a new key", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const createKey = () => `operation-${++sequence}`;
    const first = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-1", "invoice-1", createKey, storage
    );

    assert.equal(shouldRetainInvoiceRetryRequestKey(402), false);
    clearPersistedInvoiceRetryRequestKey("user-1:studio-1", "invoice-1", storage);
    const corrected = getOrCreatePersistedInvoiceRetryRequestKey(
      "user-1:studio-1", "invoice-1", createKey, storage
    );

    assert.notEqual(corrected, first);
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
