import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  areFriendlyPilotProviderMutationsEnabled,
  canManageFriendlyPilotRoutineBilling,
  FRIENDLY_PILOT_BILLING_BOUNDARY_MESSAGE,
} from "../src/lib/billing-pilot-policy.ts";

describe("Friendly Pilot billing policy", () => {
  it("allows routine local billing work only to Admin and Front Desk", () => {
    assert.equal(canManageFriendlyPilotRoutineBilling("admin"), true);
    assert.equal(canManageFriendlyPilotRoutineBilling("front_desk"), true);
    assert.equal(canManageFriendlyPilotRoutineBilling("instructor"), false);
    assert.equal(canManageFriendlyPilotRoutineBilling(null), false);
  });

  it("keeps provider mutation closed outside preview mode", () => {
    assert.equal(areFriendlyPilotProviderMutationsEnabled(false), false);
    assert.equal(areFriendlyPilotProviderMutationsEnabled(true), true);
    assert.match(FRIENDLY_PILOT_BILLING_BOUNDARY_MESSAGE, /separate approval/i);
  });
});
