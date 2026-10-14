import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
register("./helpers/path-alias-loader.mjs", import.meta.url);
const { api } = await import("../src/lib/api.ts");
const { needsFreshDashboardFacts, subscribeDashboardFactsChanged } =
  await import("../src/lib/dashboard-freshness.ts");
let clock = 100000;
for (const path of [
  "/billing/invoices/page",
  "/billing/invoices/page?cursor=next",
  "/billing/payments/page?limit=50",
  "/billing/plans",
  "/billing/landing",
  "/billing/payments/page-extra",
  "/billing/payments/payment-1",
]) {
  test(`Home freshness after ${path}`, async (t) => {
    clock += 61000;
    t.mock.method(Date, "now", () => clock);
    t.mock.method(globalThis, "fetch", async () => Response.json({ items: [] }));
    let marks = 0;
    const unsubscribe = subscribeDashboardFactsChanged(() => marks++);
    t.after(unsubscribe);
    assert.equal(needsFreshDashboardFacts(), false);
    const started = performance.now();
    await api.get(path, "synthetic");
    const neutral = /^\/billing\/(invoices|payments)\/page(?:\?|$)/.test(path);
    assert.equal(marks, neutral ? 0 : 2);
    assert.equal(needsFreshDashboardFacts(), !neutral);
    t.diagnostic(
      `synthetic read settled in ${(performance.now() - started).toFixed(1)}ms; facts marks: ${marks}; next Home fresh: ${!neutral}`,
    );
  });
}
test("a write to a page-shaped path still marks facts twice", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  let marks = 0;
  const unsubscribe = subscribeDashboardFactsChanged(() => marks++);
  t.after(unsubscribe);
  await api.post("/billing/invoices/page", {});
  assert.equal(marks, 2);
});
