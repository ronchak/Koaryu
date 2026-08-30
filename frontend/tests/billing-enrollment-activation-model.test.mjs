import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildEnrollmentActivationRequest,
  clearEnrollmentActivationRequestKey,
  resolveEnrollmentActivationRequestKey,
} from "../src/lib/billing-enrollment-activation-model.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("hidden enrollment activation adapter", () => {
  it("persists exact user, studio, and enrollment identity across reload", () => {
    const store = storage();
    let sequence = 0;
    const options = {
      createKey: () => `activation-${++sequence}`,
      enrollmentId: "enrollment-1",
      identity: { userId: "user-1", studioId: "studio-1" },
      operationIdentity: null,
      storage: store,
    };
    const first = resolveEnrollmentActivationRequestKey({
      ...options,
      keysByEnrollment: new Map(),
    });
    const reload = resolveEnrollmentActivationRequestKey({
      ...options,
      keysByEnrollment: new Map(),
    });
    assert.equal(reload, first);
    assert.equal(sequence, 1);
  });

  it("supports explicit rotation and clear after a confirmed result", () => {
    const store = storage();
    const memory = new Map();
    let sequence = 0;
    const options = {
      createKey: () => `activation-${++sequence}`,
      enrollmentId: "enrollment-1",
      identity: { userId: "user-1", studioId: "studio-1" },
      keysByEnrollment: memory,
      storage: store,
    };
    const first = resolveEnrollmentActivationRequestKey(options);
    const rotated = resolveEnrollmentActivationRequestKey({
      ...options,
      startNewRequest: true,
    });
    clearEnrollmentActivationRequestKey(options);
    const afterSuccess = resolveEnrollmentActivationRequestKey(options);
    assert.notEqual(rotated, first);
    assert.notEqual(afterSuccess, rotated);
    assert.deepEqual(buildEnrollmentActivationRequest(afterSuccess), {
      headers: { "Idempotency-Key": afterSuccess },
    });
  });

  it("keeps a scoped memory key when storage is blocked", () => {
    const blocked = {
      getItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    const memory = new Map();
    const options = {
      createKey: () => "activation-key",
      enrollmentId: "enrollment-1",
      identity: { userId: "user-1", studioId: "studio-1" },
      keysByEnrollment: memory,
      storage: blocked,
    };
    assert.equal(
      resolveEnrollmentActivationRequestKey(options),
      resolveEnrollmentActivationRequestKey(options),
    );
  });

  it("forwards a stable key into the capability-gated activation control", () => {
    const actions = fs.readFileSync(
      path.join(root, "src/lib/billing-enrollment-actions.ts"), "utf8",
    );
    const tab = fs.readFileSync(
      path.join(root, "src/components/billing/billing-enrollments-tab.tsx"), "utf8",
    );
    const model = fs.readFileSync(
      path.join(root, "src/lib/billing-enrollment-activation-model.ts"), "utf8",
    );
    assert.match(actions, /buildEnrollmentActivationRequest\(requestKey\)/);
    assert.match(actions, /if \(result\) \{[\s\S]*clearEnrollmentActivationRequestKey/);
    assert.match(tab, /canUseWorkflow\("enrollment\.activate"\)/);
    assert.match(tab, /onEnrollmentActivate\(enrollment\.id\)/);
    assert.match(tab, /enrollment-activate:/);
    assert.doesNotMatch(model, /\btoken\b|authorization/i);
  });
});
