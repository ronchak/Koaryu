import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canAccessBillingRoute,
  isBillingRoute,
} from "../src/lib/billing-route-access.ts";

describe("billing route authorization", () => {
  it("covers the billing root and every nested billing route", () => {
    assert.equal(isBillingRoute("/billing"), true);
    assert.equal(isBillingRoute("/billing/connect/refresh"), true);
    assert.equal(isBillingRoute("/billing-family"), false);
  });

  it("allows ordinary billing to admin and front desk while failing closed otherwise", () => {
    assert.equal(canAccessBillingRoute("/billing", "admin"), true);
    assert.equal(canAccessBillingRoute("/billing", "front_desk"), true);
    assert.equal(canAccessBillingRoute("/billing", "instructor"), false);
    assert.equal(canAccessBillingRoute("/billing", null), false);
    assert.equal(canAccessBillingRoute("/billing", undefined), false);
    assert.equal(canAccessBillingRoute("/students", "admin"), false);
  });

  it("keeps Connect reads admin-only while blocking the provider-mutation refresh route", () => {
    assert.equal(canAccessBillingRoute("/billing/connect", "admin"), true);
    assert.equal(canAccessBillingRoute("/billing/connect/status", "admin"), true);
    assert.equal(canAccessBillingRoute("/billing/connect", "front_desk"), false);
    assert.equal(canAccessBillingRoute("/billing/connect/refresh", "admin"), false);
    assert.equal(canAccessBillingRoute("/billing/connect/refresh/", "admin"), false);
    assert.equal(canAccessBillingRoute("/billing/connect/refresh", "front_desk"), false);
    assert.equal(canAccessBillingRoute("/billing/connect/refresh", "instructor"), false);
  });
});
