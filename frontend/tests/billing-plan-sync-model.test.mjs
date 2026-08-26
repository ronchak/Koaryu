import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPlanSyncRequest,
  clearPlanSyncRequestKey,
  resolvePlanSyncRequestKey,
} from "../src/lib/billing-plan-sync-model.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("hidden plan sync adapter", () => {
  it("persists by exact user, studio, and plan across reload", () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value),
    };
    const identity = { userId: "user-1", studioId: "studio-1" };
    const first = resolvePlanSyncRequestKey({
      createKey: () => "plan-key-1",
      identity,
      keysByPlan: new Map(),
      planId: "plan-1",
      storage,
    });
    const reload = resolvePlanSyncRequestKey({
      createKey: () => assert.fail("reload generated a key"),
      identity,
      keysByPlan: new Map(),
      planId: "plan-1",
      storage,
    });
    const otherPlan = resolvePlanSyncRequestKey({
      createKey: () => "plan-key-2",
      identity,
      keysByPlan: new Map(),
      planId: "plan-2",
      storage,
    });

    assert.equal(reload, first);
    assert.notEqual(otherPlan, first);
    assert.deepEqual(buildPlanSyncRequest(first), {
      headers: { "Idempotency-Key": "plan-key-1" },
    });
  });

  it("retains the key when storage is blocked and supports explicit rotation", () => {
    const storage = {
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
    const identity = { userId: "user-1", studioId: "studio-1" };
    const first = resolvePlanSyncRequestKey({
      createKey: () => "plan-key-1",
      identity,
      keysByPlan: memory,
      planId: "plan-1",
      storage,
    });
    const retry = resolvePlanSyncRequestKey({
      createKey: () => assert.fail("retry generated a key"),
      identity,
      keysByPlan: memory,
      planId: "plan-1",
      storage,
    });
    const rotated = resolvePlanSyncRequestKey({
      createKey: () => "plan-key-2",
      identity,
      keysByPlan: memory,
      planId: "plan-1",
      startNewRequest: true,
      storage,
    });

    assert.equal(retry, first);
    assert.equal(rotated, "plan-key-2");
  });

  it("clears only in the confirmed-result branch and stores no token", () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value),
    };
    const memory = new Map();
    const identity = { userId: "user-1", studioId: "studio-1" };
    resolvePlanSyncRequestKey({
      createKey: () => "plan-key",
      identity,
      keysByPlan: memory,
      planId: "plan-1",
      storage,
    });
    clearPlanSyncRequestKey({
      identity,
      keysByPlan: memory,
      planId: "plan-1",
      storage,
    });
    assert.equal(values.size, 0);
    assert.equal(memory.size, 0);

    const actionSource = fs.readFileSync(
      path.join(root, "src/lib/billing-plan-actions.ts"),
      "utf8",
    );
    const modelSource = fs.readFileSync(
      path.join(root, "src/lib/billing-plan-sync-model.ts"),
      "utf8",
    );
    assert.match(actionSource, /if \(result\) \{\s*clearPlanSyncRequestKey/s);
    assert.doesNotMatch(modelSource, /\btoken\b|authorization/i);
  });
});
