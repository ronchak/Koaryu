import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatBillingDate, subscriptionPeriodCopy } from "../src/lib/billing-period.ts";

describe("formatBillingDate", () => {
  it("keeps date-only billing boundaries on their Stripe calendar day", () => {
    assert.equal(formatBillingDate("2026-05-01"), "May 1, 2026");
  });

  it("keeps midnight UTC billing boundaries on their Stripe calendar day", () => {
    assert.equal(formatBillingDate("2026-05-01T00:00:00Z"), "May 1, 2026");
  });
});

describe("subscriptionPeriodCopy", () => {
  it("uses milestone copy for trial endings", () => {
    assert.deepEqual(subscriptionPeriodCopy({ status: "trialing", trial_end: "2026-05-01" }), {
      label: "Trial period",
      value: "Trial ends May 1, 2026",
    });
  });

  it("uses milestone copy for active renewals", () => {
    assert.deepEqual(subscriptionPeriodCopy({ status: "active", current_period_end: "2026-05-01T00:00:00Z" }), {
      label: "Current period",
      value: "Renews May 1, 2026",
    });
  });

  it("uses access ending copy when cancellation is scheduled", () => {
    assert.deepEqual(subscriptionPeriodCopy({ status: "active", cancel_at_period_end: true, current_period_end: "2026-05-01" }), {
      label: "Current period",
      value: "Access ends May 1, 2026",
    });
  });

  it("uses comped account copy", () => {
    assert.deepEqual(subscriptionPeriodCopy({ status: "comped", comped: true }), {
      label: "Current period",
      value: "Comped account",
    });
  });

  it("uses Stripe pending copy when milestone dates are missing", () => {
    assert.deepEqual(subscriptionPeriodCopy({ status: "active" }), {
      label: "Current period",
      value: "Dates pending from Stripe",
    });
  });
});
