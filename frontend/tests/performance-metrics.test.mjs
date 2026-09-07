import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMetricBatch, metricRoute } from "../src/lib/performance-metrics.ts";
import { createNavigationTimer, productionPerformanceEnabled } from "../src/lib/navigation-telemetry.ts";
import { POST } from "../src/app/api/performance/route.ts";
import { summarizePerformance } from "../../scripts/summarize-performance.mjs";
import { apiRequestTimeout, proxyRequestTimeout } from "../src/lib/request-budget.ts";

const event = { route: "schedule", name: "navigation_useful", value: 123, navigation: "link", outcome: "success" };
const batch = { version: "a".repeat(40), events: [event] };

test("navigation timing includes the entire delayed route read and rejects superseded readiness", () => {
  const events = [];
  let now = 100;
  const timer = createNavigationTimer(e => events.push(e), () => now);
  timer.start("schedule", "link");
  now = 900; timer.stage("schedule", "commit");
  now = 950; timer.stage("schedule", "useful");
  assert.equal(events[0].value, 800); assert.equal(events[1].value, 850);
  timer.start("billing", "link");
  timer.stage("schedule", "complete");
  assert.equal(events.length, 3); assert.equal(events[2].outcome, "superseded");
  timer.fail("timeout");
  assert.equal(events.at(-1).route, "billing");
  assert.equal(events.at(-1).outcome, "timeout");
});

test("metrics allow only bounded numeric measurements and fixed route labels", () => {
  assert.deepEqual(parseMetricBatch(batch), batch);
  assert.equal(metricRoute("/students/private-id?email=private"), "other");
  for (const invalid of [
    { ...batch, email: "private" }, { ...batch, events: [{ ...event, email: "private" }] },
    { ...batch, events: [{ ...event, route: "/students/private" }] },
    { ...batch, events: [{ ...event, value: Infinity }] },
    { ...batch, events: [{ ...event, value: 999999 }] },
    { ...batch, events: Array(11).fill(event) },
  ]) assert.equal(parseMetricBatch(invalid), null);
});

function request(body, headers = {}) {
  return new Request("https://example.test/api/performance", { method: "POST", body,
    headers: { "Content-Type": "application/json", Origin: "https://example.test", "Sec-Fetch-Site": "same-origin", ...headers },
  });
}

test("collector rejects cross-site, private fields and oversized input before logging", async (t) => {
  const prior = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  t.after(() => { if (prior === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prior; });
  const log = t.mock.method(console, "info", () => {});
  assert.equal((await POST(request(JSON.stringify(batch), { Origin: "https://elsewhere.test" }))).status, 403);
  assert.equal((await POST(request(JSON.stringify({ ...batch, token: "private" })))).status, 400);
  assert.equal((await POST(request("x".repeat(4097)))).status, 413);
  assert.equal(log.mock.callCount(), 0);
  assert.equal((await POST(request(JSON.stringify(batch)))).status, 204);
  assert.equal(log.mock.callCount(), 1);
  assert.match(log.mock.calls[0].arguments[0], /koaryu:metrics/);
});

test("rollups exclude unrelated logs and distinguish small samples from reliable tail comparisons", () => {
  const lines = ["unrelated private log", JSON.stringify({ message: `[koaryu:metrics] ${JSON.stringify({ environment: "production", release: batch.version, ...batch })}` }),
    `[koaryu:metrics] ${JSON.stringify({ environment: "staging", release: batch.version, ...batch })}`];
  const result = summarizePerformance(lines);
  assert.equal(result.length, 1); assert.equal(result[0].p95, 123);
  assert.equal(result[0].sufficient_for_tail_comparison, false);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("browser and proxy deadlines leave room for the entire server operation", () => {
  for (const [path, method, server] of [["/billing/landing", "GET", 30000], ["/students/import/execute", "POST", 120000], ["/schedule/window/materialize", "POST", 120000]]) {
    assert.ok(proxyRequestTimeout(path, method) > server);
    assert.ok(apiRequestTimeout(path, method) > proxyRequestTimeout(path, method));
  }
  assert.ok(apiRequestTimeout("/students/import/execute", "POST") >= 60_000 + proxyRequestTimeout("/students/import/execute", "POST") + 5_000);
});

test("optimized preview and staging builds cannot be sampled as production traffic", () => {
  assert.equal(productionPerformanceEnabled("production", false), true);
  for (const environment of ["staging", "preview", "development", "local"]) assert.equal(productionPerformanceEnabled(environment, false), false);
  assert.equal(productionPerformanceEnabled("production", true), false);
});
