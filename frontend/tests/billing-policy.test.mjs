import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  areProviderMutationsEnabled,
  canManageRoutineBilling,
  canStartCoreCheckout,
  resolveBillingProviderCopy,
} from "../src/lib/billing-policy.ts";

describe("billing policy", () => {
  it("allows routine local billing work only to Admin and Front Desk", () => {
    assert.equal(canManageRoutineBilling("admin"), true);
    assert.equal(canManageRoutineBilling("front_desk"), true);
    assert.equal(canManageRoutineBilling("instructor"), false);
    assert.equal(canManageRoutineBilling(null), false);
  });

  it("fails closed outside preview unless the server grants the studio capability", () => {
    assert.equal(areProviderMutationsEnabled(false), false);
    assert.equal(areProviderMutationsEnabled(true), true);
    assert.equal(areProviderMutationsEnabled(false, true), true);
  });

  it("never offers Core checkout to a comped studio", () => {
    assert.equal(canStartCoreCheckout(null), false);
    assert.equal(canStartCoreCheckout({ can_start_checkout: true }), true);
    assert.equal(canStartCoreCheckout({ can_start_checkout: false }), false);
    assert.equal(canStartCoreCheckout({}), false);
  });

  it("derives live copy independently from each studio-scoped permit", () => {
    const copy = resolveBillingProviderCopy({
      isPreviewMode: false,
      providerMode: "live",
      coreSubscription: true,
      connectOnboarding: false,
      connectPayments: true,
    });

    assert.match(copy.coreSubscription, /Live Stripe.*authorized for this studio/i);
    assert.match(copy.connectOnboarding, /Live Stripe.*not authorized for this studio/i);
    assert.match(copy.connectPayments, /Live Stripe.*authorized for this studio/i);
    assert.equal(copy.boundary, `${copy.coreSubscription} ${copy.connectOnboarding} ${copy.connectPayments}`);
  });

  it("distinguishes test, preview, and unloaded provider state", () => {
    const testCopy = resolveBillingProviderCopy({
      isPreviewMode: false,
      providerMode: "test",
      coreSubscription: false,
      connectOnboarding: true,
      connectPayments: false,
    });
    assert.match(testCopy.connectOnboarding, /Stripe test-mode.*authorized/i);
    assert.match(testCopy.connectPayments, /Stripe test-mode.*not authorized/i);

    const unloaded = resolveBillingProviderCopy({
      isPreviewMode: false,
      providerMode: null,
      coreSubscription: true,
      connectOnboarding: true,
      connectPayments: true,
    });
    assert.match(unloaded.boundary, /unavailable until provider mode and studio authorization load/i);

    const preview = resolveBillingProviderCopy({
      isPreviewMode: true,
      providerMode: "live",
      coreSubscription: true,
      connectOnboarding: true,
      connectPayments: true,
    });
    assert.match(preview.boundary, /demo-only/i);
    assert.match(preview.boundary, /does not change provider state/i);
  });
});
