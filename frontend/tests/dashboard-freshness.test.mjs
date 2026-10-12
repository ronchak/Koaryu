import assert from "node:assert/strict";
import { describe, it } from "node:test";

const CHANGE_KEY = "koaryu:facts-changed-at";
let importId = 0;

async function fixture(t, { browser = true } = {}) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map();
  const handlers = new Set();
  const target = new EventTarget();
  const fakeWindow = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    addEventListener: (type, listener) => {
      assert.equal(type, "storage");
      handlers.add(listener);
      target.addEventListener(type, listener);
    },
    removeEventListener: (type, listener) => {
      assert.equal(type, "storage");
      handlers.delete(listener);
      target.removeEventListener(type, listener);
    },
  };
  if (browser)
    Object.defineProperty(globalThis, "window", {
      value: fakeWindow,
      configurable: true,
      writable: true,
    });
  else delete globalThis.window;
  const unsubscribers = [];
  t.after(() => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  // Each test gets fresh module state without adding a production reset API.
  const api = await import(`../src/lib/dashboard-freshness.ts?test=${++importId}`);
  return {
    ...api,
    storage,
    handlers,
    fakeWindow,
    subscribe(listener) {
      const unsubscribe = api.subscribeDashboardFactsChanged(listener);
      unsubscribers.push(unsubscribe);
      return unsubscribe;
    },
    emitStorage(key) {
      const event = new Event("storage");
      Object.defineProperty(event, "key", { value: key });
      target.dispatchEvent(event);
    },
  };
}

describe("dashboard freshness subscription", () => {
  it("mark synchronously notifies after persisting the facts timestamp", async (t) => {
    const f = await fixture(t);
    const calls = [];
    f.subscribe(() => {
      const timestamp = f.storage.get(CHANGE_KEY);
      calls.push([timestamp, f.needsFreshDashboardFacts(Number(timestamp))]);
    });
    f.markDashboardFactsChanged(2000);
    assert.deepEqual(calls, [["2000", true]], "listener must run before mark returns");
    f.markDashboardFactsChanged(3000);
    assert.deepEqual(calls, [
      ["2000", true],
      ["3000", true],
    ]);
  });

  it("unsubscribe removes same-tab and storage listeners and is idempotent", async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const unsubscribe = f.subscribe(() => calls++);
    assert.equal(f.handlers.size, 1);
    f.markDashboardFactsChanged(2000);
    f.emitStorage(CHANGE_KEY);
    assert.equal(calls, 2);
    unsubscribe();
    unsubscribe();
    assert.equal(f.handlers.size, 0);
    f.markDashboardFactsChanged(3000);
    f.emitStorage(CHANGE_KEY);
    assert.equal(calls, 2);
  });

  it("subscribing the same listener twice creates independently removable subscriptions", async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const listener = () => calls++;
    const first = f.subscribe(listener);
    const second = f.subscribe(listener);
    assert.equal(f.handlers.size, 2);
    f.markDashboardFactsChanged(2000);
    assert.equal(calls, 2);
    f.emitStorage(CHANGE_KEY);
    assert.equal(calls, 4);
    first();
    f.markDashboardFactsChanged(3000);
    f.emitStorage(CHANGE_KEY);
    assert.equal(calls, 6);
    assert.equal(f.handlers.size, 1);
    second();
    f.markDashboardFactsChanged(4000);
    f.emitStorage(CHANGE_KEY);
    assert.equal(calls, 6);
  });

  it("throwing listener cannot fail a marking request or suppress other listeners; rethrow is deferred", async (t) => {
    const f = await fixture(t);
    const failure = new Error("Synthetic subscriber failure");
    const tasks = [];
    t.mock.method(globalThis, "setTimeout", (callback, delay) => {
      tasks.push({ callback, delay });
      return tasks.length;
    });
    let calls = 0;
    f.subscribe(() => {
      throw failure;
    });
    f.subscribe(() => calls++);
    assert.doesNotThrow(() => f.markDashboardFactsChanged(2000));
    assert.equal(calls, 1);
    assert.equal(f.storage.get(CHANGE_KEY), "2000");
    assert.equal(f.needsFreshDashboardFacts(2001), true);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].delay, 0);
    assert.throws(tasks[0].callback, (error) => error === failure);
  });

  it("storage events notify only for the facts key and read the shared timestamp", async (t) => {
    const f = await fixture(t);
    let calls = 0;
    f.subscribe(() => calls++);
    f.emitStorage("another-key");
    f.emitStorage(null);
    assert.equal(calls, 0);
    f.storage.set(CHANGE_KEY, "3000");
    f.emitStorage(CHANGE_KEY);
    assert.equal(calls, 1);
    assert.equal(f.needsFreshDashboardFacts(3001), true);
    assert.equal(f.needsFreshDashboardFacts(63000), false);
  });

  it("needsFresh retains the 60-second boundary and ignores future/malformed timestamps", async (t) => {
    const f = await fixture(t);
    assert.equal(f.needsFreshDashboardFacts(1000), false);
    f.markDashboardFactsChanged(2000);
    assert.equal(f.needsFreshDashboardFacts(1999), false);
    assert.equal(f.needsFreshDashboardFacts(2000), true);
    assert.equal(f.needsFreshDashboardFacts(61999), true);
    assert.equal(f.needsFreshDashboardFacts(62000), false);
    f.storage.set(CHANGE_KEY, "63000");
    assert.equal(f.needsFreshDashboardFacts(63001), true);
    for (const value of ["invalid", "Infinity", "NaN", "999999"]) {
      f.storage.set(CHANGE_KEY, value);
      assert.equal(f.needsFreshDashboardFacts(64000), false, value);
    }
    // Invalid shared values must not erase a valid same-tab mark.
    f.markDashboardFactsChanged(65000);
    f.storage.set(CHANGE_KEY, "invalid");
    assert.equal(f.needsFreshDashboardFacts(65001), true);
  });

  it("subscribing and unrelated storage events never mark facts fresh", async (t) => {
    const f = await fixture(t);
    const unsubscribe = f.subscribe(() => {});
    f.emitStorage("unrelated-key");
    f.emitStorage(CHANGE_KEY);
    assert.equal(f.needsFreshDashboardFacts(100000), false);
    unsubscribe();
    assert.equal(f.needsFreshDashboardFacts(100000), false);
  });

  it("unavailable localStorage still notifies and protects recent same-tab facts", async (t) => {
    const f = await fixture(t);
    f.fakeWindow.localStorage = {
      getItem() {
        throw new Error("Storage blocked");
      },
      setItem() {
        throw new Error("Storage blocked");
      },
    };
    let calls = 0;
    f.subscribe(() => calls++);
    assert.doesNotThrow(() => f.markDashboardFactsChanged(2000));
    assert.equal(calls, 1);
    assert.equal(f.needsFreshDashboardFacts(2001), true);
    assert.equal(f.needsFreshDashboardFacts(62000), false);
  });

  it("subscription, marking and cleanup also work without a browser window", async (t) => {
    const f = await fixture(t, { browser: false });
    let calls = 0;
    const unsubscribe = f.subscribe(() => calls++);
    assert.equal(f.needsFreshDashboardFacts(1000), false);
    f.markDashboardFactsChanged(2000);
    assert.equal(calls, 1);
    assert.equal(f.needsFreshDashboardFacts(2001), true);
    unsubscribe();
    f.markDashboardFactsChanged(3000);
    assert.equal(calls, 1);
  });
});
