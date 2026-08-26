import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  clearEnrollmentTransitionRequestKey,
  enrollmentTransitionRequestOptions,
  resolveEnrollmentTransitionRequestKey,
} from "../src/lib/billing-enrollment-transition-model.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

describe("billing enrollment transition request keys", () => {
  it("persists across reload and scopes by user, studio, action, and resource", () => {
    const persisted = storage();
    const identity = { userId: "user-1", studioId: "studio-1" };
    const first = resolveEnrollmentTransitionRequestKey({
      action: "schedule-period-end",
      createKey: () => "key-1",
      identity,
      keys: new Map(),
      resourceId: "enrollment-1",
      storage: persisted,
    });
    const reloaded = resolveEnrollmentTransitionRequestKey({
      action: "schedule-period-end",
      createKey: () => "wrong",
      identity,
      keys: new Map(),
      resourceId: "enrollment-1",
      storage: persisted,
    });
    const otherAction = resolveEnrollmentTransitionRequestKey({
      action: "cancel-immediate",
      createKey: () => "key-2",
      identity,
      keys: new Map(),
      resourceId: "enrollment-1",
      storage: persisted,
    });
    const otherStudio = resolveEnrollmentTransitionRequestKey({
      action: "schedule-period-end",
      createKey: () => "key-3",
      identity: { userId: "user-1", studioId: "studio-2" },
      keys: new Map(),
      resourceId: "enrollment-1",
      storage: persisted,
    });

    assert.equal(first, "key-1");
    assert.equal(reloaded, "key-1");
    assert.equal(otherAction, "key-2");
    assert.equal(otherStudio, "key-3");
  });

  it("retains unknown attempts, rotates deliberately, and clears only confirmed success", () => {
    const persisted = storage();
    const keys = new Map();
    const identity = { userId: "user-1", studioId: "studio-1" };
    const base = {
      action: "revoke-scheduled",
      identity,
      keys,
      resourceId: "transition-1",
      storage: persisted,
    };
    assert.equal(resolveEnrollmentTransitionRequestKey({ ...base, createKey: () => "key-1" }), "key-1");
    assert.equal(resolveEnrollmentTransitionRequestKey({ ...base, createKey: () => "wrong" }), "key-1");
    assert.equal(resolveEnrollmentTransitionRequestKey({
      ...base,
      createKey: () => "key-2",
      startNewRequest: true,
    }), "key-2");
    clearEnrollmentTransitionRequestKey(base);
    assert.equal(resolveEnrollmentTransitionRequestKey({ ...base, createKey: () => "key-3" }), "key-3");
    assert.deepEqual(enrollmentTransitionRequestOptions("key-3"), {
      headers: { "Idempotency-Key": "key-3" },
    });
  });

  it("keeps working when browser storage is blocked", () => {
    const blocked = {
      getItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
    };
    const keys = new Map();
    const options = {
      action: "cancel-immediate",
      identity: { userId: "user", studioId: "studio" },
      keys,
      resourceId: "enrollment",
      storage: blocked,
    };
    assert.equal(resolveEnrollmentTransitionRequestKey({ ...options, createKey: () => "key-1" }), "key-1");
    assert.equal(resolveEnrollmentTransitionRequestKey({ ...options, createKey: () => "wrong" }), "key-1");
  });

  it("wires named routes into capability-gated controls without clearing unknown attempts", () => {
    const actions = fs.readFileSync(
      path.join(root, "src/lib/billing-enrollment-actions.ts"), "utf8",
    );
    const tab = fs.readFileSync(
      path.join(root, "src/components/billing/billing-enrollments-tab.tsx"), "utf8",
    );

    assert.match(actions, /enrollmentTransitionRequestOptions\(requestKey\)/);
    assert.match(actions, /if \(result\) \{[\s\S]*clearEnrollmentTransitionRequestKey/);
    assert.match(actions, /schedule-period-end/);
    assert.match(actions, /revoke-scheduled/);
    assert.match(actions, /cancel-immediate/);
    assert.match(tab, /onEnrollmentSchedulePeriodEnd\(enrollment\.id\)/);
    assert.match(tab, /onEnrollmentRevokeScheduled\(scheduled\.intentId, scheduled\.revision\)/);
    assert.match(tab, /onEnrollmentCancelImmediate\(enrollment\.id\)/);
    assert.match(tab, /window\.confirm\("Cancel this recurring enrollment immediately\?/);
    assert.match(tab, /enrollment\.cancel\.period_end\.schedule/);
    assert.match(tab, /enrollment\.cancel\.period_end\.revoke/);
    assert.match(tab, /enrollment\.cancel\.immediate/);
  });
});
