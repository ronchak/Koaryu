import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  areProviderMutationsEnabled,
  BILLING_BOUNDARY_MESSAGE,
  canManageRoutineBilling,
} from "../src/lib/billing-policy.ts";

describe("billing policy", () => {
  it("allows routine local billing work only to Admin and Front Desk", () => {
    assert.equal(canManageRoutineBilling("admin"), true);
    assert.equal(canManageRoutineBilling("front_desk"), true);
    assert.equal(canManageRoutineBilling("instructor"), false);
    assert.equal(canManageRoutineBilling(null), false);
  });

  it("keeps provider mutations disabled outside preview mode", () => {
    assert.equal(areProviderMutationsEnabled(false), false);
    assert.equal(areProviderMutationsEnabled(true), true);
    assert.match(BILLING_BOUNDARY_MESSAGE, /currently disabled/i);
  });
});
