import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACCOUNT_ARCHIVED_ROUTE,
  resolveMembershipRoute,
} from "../src/lib/auth-route-model.ts";

function route(overrides = {}) {
  return resolveMembershipRoute({
    authenticated: true,
    hasStudio: true,
    isAuthRoute: false,
    isOnboardingRoute: false,
    membershipStatus: "active",
    pathname: "/dashboard",
    ...overrides,
  });
}

describe("membership route model", () => {
  it("keeps archived sessions on the stable archived account route and out of tenant routes", () => {
    assert.equal(route({ membershipStatus: "archived", pathname: "/login", isAuthRoute: true }), ACCOUNT_ARCHIVED_ROUTE);
    assert.equal(route({ membershipStatus: "archived", pathname: "/onboarding", isOnboardingRoute: true }), ACCOUNT_ARCHIVED_ROUTE);
    assert.equal(route({ membershipStatus: "archived", pathname: "/dashboard" }), ACCOUNT_ARCHIVED_ROUTE);
    assert.equal(route({ membershipStatus: "archived", pathname: ACCOUNT_ARCHIVED_ROUTE }), null);
  });

  it("routes active and no-membership visits to the archived route without a loop", () => {
    assert.equal(route({ membershipStatus: "active", pathname: ACCOUNT_ARCHIVED_ROUTE }), "/dashboard");
    assert.equal(route({ membershipStatus: "none", hasStudio: false, pathname: ACCOUNT_ARCHIVED_ROUTE }), "/onboarding");
    assert.equal(route({ membershipStatus: "active", pathname: "/login", isAuthRoute: true }), "/dashboard");
    assert.equal(route({ membershipStatus: "none", hasStudio: false, pathname: "/login", isAuthRoute: true }), "/onboarding");
  });

  it("preserves existing active and no-membership onboarding behavior", () => {
    assert.equal(route({ membershipStatus: "active", pathname: "/onboarding", isOnboardingRoute: true }), "/dashboard");
    assert.equal(route({ membershipStatus: "none", hasStudio: false, pathname: "/onboarding", isOnboardingRoute: true }), null);
    assert.equal(route({ membershipStatus: "none", hasStudio: false, pathname: "/dashboard" }), "/onboarding");
    assert.equal(route({ membershipStatus: "active", pathname: "/dashboard" }), null);
  });

  it("sends unauthenticated protected access to login while allowing auth pages", () => {
    assert.equal(route({ authenticated: false, pathname: ACCOUNT_ARCHIVED_ROUTE }), "/login");
    assert.equal(route({ authenticated: false, pathname: "/dashboard" }), "/login");
    assert.equal(route({ authenticated: false, pathname: "/login", isAuthRoute: true }), null);
  });
});
