import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const pageSource = readFileSync(
  new URL("../src/app/(dashboard)/subscription-required/page.tsx", import.meta.url),
  "utf8"
);

describe("subscription-required billing contract", () => {
  it("keeps the page read-only and routes blocked studios to support", () => {
    assert.doesNotMatch(pageSource, /api\.post/);
    assert.doesNotMatch(pageSource, /platform-billing\/(?:checkout|portal)/);
    assert.doesNotMatch(pageSource, /window\.location\.assign/);
    assert.doesNotMatch(pageSource, /30-day Stripe trial|checkout is completed|Start or restore/);
    assert.doesNotMatch(pageSource, /loadError instanceof Error/);
    assert.match(pageSource, /api\.get<PlatformBillingStatus>/);
    assert.match(pageSource, /if \(profile\.role !== "admin"\) \{\s*return;\s*\}/);
    assert.ok(
      pageSource.indexOf('profile.role !== "admin"')
        < pageSource.indexOf('api.get<PlatformBillingStatus>')
    );
    assert.match(pageSource, /showAdminBillingDetails = isAdmin && billingStatus !== null/);
    assert.match(pageSource, /Billing details are limited to studio administrators/);
    assert.match(pageSource, /No subscription status, price, or payment details are shown/);
    assert.match(pageSource, /checkout and portal actions are currently disabled/i);
    assert.match(pageSource, /mailto:support@koaryu\.app/);
  });
});
