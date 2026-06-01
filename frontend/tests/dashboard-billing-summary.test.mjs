import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canViewDashboardBilling,
  getDashboardBillingActionKind,
  isDashboardBillingSetupComplete,
  selectDashboardBillingSummary,
} from "../src/lib/dashboard-billing-summary.ts";

function summary(overrides = {}) {
  return {
    billing: {
      can_view_billing: true,
      payment_attention_count: 0,
      has_plans: true,
      payments_ready: true,
    },
    setup: {
      has_tuition_plans: true,
    },
    ...overrides,
  };
}

describe("dashboard billing summary", () => {
  it("selects billing state from the backend summary when it is available", () => {
    assert.deepEqual(
      selectDashboardBillingSummary({
        isPreviewMode: true,
        summary: summary({
          billing: {
            can_view_billing: true,
            payment_attention_count: 2,
            has_plans: false,
            payments_ready: false,
          },
        }),
      }),
      {
        paymentAttentionCount: 2,
        hasPlans: false,
        paymentsReady: false,
      }
    );
  });

  it("honors backend billing visibility before local role assumptions", () => {
    const hiddenSummary = summary({
      billing: {
        can_view_billing: false,
        payment_attention_count: 4,
        has_plans: true,
        payments_ready: false,
      },
    });

    assert.equal(
      canViewDashboardBilling({
        currentRole: "admin",
        summary: hiddenSummary,
      }),
      false
    );
    assert.equal(
      canViewDashboardBilling({
        currentRole: "front_desk",
        summary: null,
      }),
      true
    );
    assert.deepEqual(
      selectDashboardBillingSummary({
        isPreviewMode: false,
        summary: hiddenSummary,
      }),
      {
        paymentAttentionCount: null,
        hasPlans: null,
        paymentsReady: null,
      }
    );
  });

  it("uses explicit preview and not-loaded states instead of fetching Billing page endpoints", () => {
    assert.deepEqual(
      selectDashboardBillingSummary({
        isPreviewMode: true,
        summary: null,
      }),
      {
        paymentAttentionCount: 1,
        hasPlans: true,
        paymentsReady: true,
      }
    );
    assert.deepEqual(
      selectDashboardBillingSummary({
        isPreviewMode: false,
        summary: null,
      }),
      {
        paymentAttentionCount: null,
        hasPlans: null,
        paymentsReady: null,
      }
    );
  });

  it("derives billing setup completion from summary setup flags before local billing hints", () => {
    assert.equal(
      isDashboardBillingSetupComplete({
        billingSummary: {
          paymentAttentionCount: 0,
          hasPlans: true,
          paymentsReady: true,
        },
        summary: summary({
          setup: {
            has_tuition_plans: false,
          },
        }),
      }),
      false
    );
    assert.equal(
      isDashboardBillingSetupComplete({
        billingSummary: {
          paymentAttentionCount: 0,
          hasPlans: true,
          paymentsReady: true,
        },
        summary: null,
      }),
      true
    );
  });

  it("exposes billing actions only for roles that can see billing", () => {
    const issueSummary = {
      paymentAttentionCount: 3,
      hasPlans: true,
      paymentsReady: true,
    };
    const setupSummary = {
      paymentAttentionCount: null,
      hasPlans: false,
      paymentsReady: false,
    };

    assert.equal(
      getDashboardBillingActionKind({
        billingSummary: issueSummary,
        canSeeBilling: true,
      }),
      "payment-issues"
    );
    assert.equal(
      getDashboardBillingActionKind({
        billingSummary: setupSummary,
        canSeeBilling: true,
      }),
      "payments-setup"
    );
    assert.equal(
      getDashboardBillingActionKind({
        billingSummary: issueSummary,
        canSeeBilling: false,
      }),
      null
    );
  });
});
