import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getBillingInitialLoadAction,
  resolveBillingAuxiliaryReadiness,
  shouldSettleBillingLoadEarly,
  shouldShowBillingLoading,
} from "../src/lib/billing-page-state.ts";

describe("getBillingInitialLoadAction", () => {
  it("routes Stripe Connect returns directly to status synchronization", () => {
    assert.equal(getBillingInitialLoadAction("?connect=return"), "connect-return");
    assert.equal(getBillingInitialLoadAction("?tab=plans&connect=return"), "connect-return");
  });

  it("uses the normal billing refresh for unrelated query parameters", () => {
    assert.equal(getBillingInitialLoadAction(""), "billing");
    assert.equal(getBillingInitialLoadAction("?connect=cancel"), "billing");
  });
});

describe("resolveBillingAuxiliaryReadiness", () => {
  const ready = {
    activeTab: "overview",
    initialLoadAction: "billing",
    programsLoadError: null,
    programsLoaded: true,
    studentsLoadError: null,
    studentsLoaded: true,
    studentsMayBePartial: false,
  };

  it("declares only the dataset consumed by the active billing tab", () => {
    assert.equal(resolveBillingAuxiliaryReadiness(ready).status, "ready");
    assert.equal(resolveBillingAuxiliaryReadiness({
      ...ready,
      programsLoaded: false,
    }).status, "ready", "overview does not consume programs");
    assert.equal(resolveBillingAuxiliaryReadiness({
      ...ready,
      studentsLoadError: "Roster timed out",
    }).status, "error");
    assert.equal(resolveBillingAuxiliaryReadiness({
      ...ready,
      activeTab: "plans",
      programsLoaded: false,
      studentsLoadError: "Roster timed out",
    }).status, "loading", "plans consume programs but not students");
    assert.equal(resolveBillingAuxiliaryReadiness({
      ...ready,
      activeTab: "families",
      programsLoadError: "Programs failed",
      programsLoaded: false,
      studentsLoadError: "Roster failed",
      studentsLoaded: false,
    }).status, "ready", "families use billing data only");
  });

  it("keeps Connect return synchronization independent from auxiliary datasets", () => {
    assert.deepEqual(resolveBillingAuxiliaryReadiness({
      ...ready,
      initialLoadAction: "connect-return",
      programsLoadError: "Programs failed",
      programsLoaded: false,
      studentsLoadError: "Roster failed",
      studentsLoaded: false,
    }), { error: null, status: "ready" });
  });
});

describe("shouldShowBillingLoading", () => {
  it("shows loading while a live billing load is active before account data exists", () => {
    assert.equal(
      shouldShowBillingLoading({
        isPreviewMode: false,
        hasPaymentAccount: false,
        isLoading: true,
        hasBillingLoadSettled: false,
        error: "",
      }),
      true,
    );
  });

  it("does not show loading after a failed settled live billing load", () => {
    assert.equal(
      shouldShowBillingLoading({
        isPreviewMode: false,
        hasPaymentAccount: false,
        isLoading: false,
        hasBillingLoadSettled: true,
        error: "Stripe Connect: unavailable",
      }),
      false,
    );
  });

  it("does not show loading for preview mode or already-loaded account data", () => {
    assert.equal(
      shouldShowBillingLoading({
        isPreviewMode: true,
        hasPaymentAccount: false,
        isLoading: true,
        hasBillingLoadSettled: false,
        error: "",
      }),
      false,
    );
    assert.equal(
      shouldShowBillingLoading({
        isPreviewMode: false,
        hasPaymentAccount: true,
        isLoading: true,
        hasBillingLoadSettled: false,
        error: "",
      }),
      false,
    );
  });

  it("shows loading before the initial live billing load has settled", () => {
    assert.equal(
      shouldShowBillingLoading({
        isPreviewMode: false,
        hasPaymentAccount: false,
        isLoading: false,
        hasBillingLoadSettled: false,
        error: "",
      }),
      true,
    );
  });
});

describe("shouldSettleBillingLoadEarly", () => {
  it("does not settle the load while the live user role is still unknown", () => {
    assert.equal(
      shouldSettleBillingLoadEarly({
        isPreviewMode: false,
        hasKnownRestrictedRole: false,
      }),
      false,
    );
  });

  it("settles early for preview mode or a known restricted role", () => {
    assert.equal(
      shouldSettleBillingLoadEarly({
        isPreviewMode: true,
        hasKnownRestrictedRole: false,
      }),
      true,
    );
    assert.equal(
      shouldSettleBillingLoadEarly({
        isPreviewMode: false,
        hasKnownRestrictedRole: true,
      }),
      true,
    );
  });
});
