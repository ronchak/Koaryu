import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const pageSource = readFileSync(
  new URL("../src/app/(dashboard)/subscription-required/page.tsx", import.meta.url),
  "utf8"
);

describe("subscription-required billing contract", () => {
  it("shows Stripe-hosted recovery only when the backend authorizes Core billing", () => {
    assert.match(pageSource, /api\.post<BillingLinkResponse>/);
    assert.match(pageSource, /`\/platform-billing\/\$\{action\}`/);
    assert.match(pageSource, /window\.location\.assign\(link\.url\)/);
    assert.match(pageSource, /billingSystemStatus\?\.mutation_capabilities\.core_subscription === true/);
    assert.match(pageSource, /canStartCheckout \?/);
    assert.match(pageSource, /canOpenPortal \?/);
    assert.match(pageSource, /Idempotency-Key/);
    assert.doesNotMatch(pageSource, /loadError instanceof Error/);
    assert.match(pageSource, /api\.get<PlatformBillingStatus>/);
    assert.match(pageSource, /api\.get<BillingSystemStatus>/);
    assert.match(pageSource, /if \(profile\.role !== "admin"\) \{\s*return;\s*\}/);
    assert.ok(
      pageSource.indexOf('profile.role !== "admin"')
        < pageSource.indexOf('api.get<PlatformBillingStatus>')
    );
    assert.match(pageSource, /showAdminBillingDetails = isAdmin && billingStatus !== null/);
    assert.match(pageSource, /Billing details are limited to studio administrators/);
    assert.match(pageSource, /No subscription status, price, or payment details are shown/);
    assert.match(pageSource, /checkout and portal actions are currently disabled/i);
    assert.match(pageSource, /Start Koaryu Core/);
    assert.match(pageSource, /Customer portal/);
    assert.match(pageSource, /mailto:support@koaryu\.app/);
  });
});
