import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldSettleBillingLoadEarly, shouldShowBillingLoading } from "../src/lib/billing-page-state.ts";

describe("shouldShowBillingLoading", () => {
  it("shows loading while a live billing load is active before account data exists", () => {
    assert.equal(
      shouldShowBillingLoading({
        isPreviewMode: false,
        isStudioBootstrapSettled: true,
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
        isStudioBootstrapSettled: true,
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
        isStudioBootstrapSettled: true,
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
        isStudioBootstrapSettled: true,
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
        isStudioBootstrapSettled: true,
        hasPaymentAccount: false,
        isLoading: false,
        hasBillingLoadSettled: false,
        error: "",
      }),
      true,
    );
  });

  it("shows loading while studio bootstrap is still settling", () => {
    assert.equal(
      shouldShowBillingLoading({
        isPreviewMode: false,
        isStudioBootstrapSettled: false,
        hasPaymentAccount: false,
        isLoading: false,
        hasBillingLoadSettled: true,
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
