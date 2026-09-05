import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { chromium } from "@playwright/test";

import {
  captureDashboardPerformance,
  classifyResource,
  measureDashboardReady,
  openVerifiedBrowser,
  sanitizeServerTiming,
  stabilizeWebVitals,
  validateCapturedEvidence,
  verifyPostCaptureRelease,
  WEB_VITALS_STABILIZATION,
} from "../scripts/capture-dashboard-performance.mjs";

const homeSource = readFileSync(new URL("../src/components/dashboard/dashboard-home.tsx", import.meta.url), "utf8");
const controllerSource = readFileSync(new URL("../src/lib/dashboard-page-controller.ts", import.meta.url), "utf8");
const captureSource = readFileSync(new URL("../scripts/capture-dashboard-performance.mjs", import.meta.url), "utf8");

function deferredCapture() {
  const sizes = Promise.withResolvers();
  const lateSizes = Promise.withResolvers();
  const page = new EventEmitter();
  const request = (path, responseSizes = async () => ({ responseBodySize: 0 })) => ({
    url: () => `https://frontend.invalid${path}?email=private@example.invalid`,
    resourceType: () => "fetch",
    sizes: responseSizes,
  });
  let lateSizeCalls = 0;
  const completed = request("/api/dashboard/bootstrap", () => sizes.promise);
  const pending = request("/private-student", () => {
    lateSizeCalls += 1;
    return lateSizes.promise;
  });
  const pendingFailure = request("/api/dashboard/summary");
  const failed = request("/private-failed");
  const respond = (request, status) => page.emit("response", {
    request: () => request,
    status: () => status,
    url: request.url,
    headers: () => ({ "server-timing": "koaryu_total;dur=1, secret;desc=private" }),
  });
  page.route = async () => {};
  page.addInitScript = async () => {};
  page.waitForFunction = async () => {};
  page.url = () => "https://frontend.invalid/billing";
  page.goto = async () => {
    for (const entry of [completed, pending, pendingFailure, failed]) page.emit("request", entry);
    respond(completed, 200);
    respond(pending, 202);
    page.emit("requestfinished", completed);
    page.emit("requestfailed", failed);
  };
  let evaluateCalls = 0;
  const snapshotWait = Promise.withResolvers();
  page.evaluate = async (read) => {
    if (read.name === "readVisualReadiness") return { ready: true, image_failed: false, lcp: 2, cls: 0 };
    if (evaluateCalls++ === 0) {
      return ["navigation.started", "visible.shell", "visible.identity", "visible.useful", "visible.complete"].map((stage, index) => ({
        name: `koaryu.${stage}`, startTime: index * 10,
        detail: { route: "billing", identity_generation: 2, navigation_generation: 1 },
      }));
    }
    // The capture reaches its final await through promise microtasks first. This
    // next task runs while the first request's size lookup is still deferred.
    setImmediate(() => snapshotWait.resolve());
    return {
      navigation: { dom_content_loaded_ms: 2, load_event_ms: 3 },
      first_contentful_paint_ms: 1, largest_contentful_paint_ms: 2,
      cumulative_layout_shift: 0, resources: [], interactions: [], long_tasks: [],
    };
  };
  let closed = false;
  let verifications = 0;
  const capture = captureDashboardPerformance({
    route: "billing", frontendOrigin: "https://frontend.invalid",
    backendApi: "https://backend.invalid/api/v1", storageState: "/private/state.json",
  }, {
    verifyDeployment: async () => {
      verifications += 1;
      return { verified: true, expected_sha: "a".repeat(40), environment: "staging" };
    },
    launchBrowser: async () => ({
      newContext: async () => ({ newPage: async () => page }),
      version: () => "test-browser", close: async () => { closed = true; },
    }),
  });
  return {
    capture, sizes, lateSizes, snapshotWait: snapshotWait.promise,
    state: () => ({ closed, verifications, lateSizeCalls }),
    finishDuringSnapshot: () => {
      respond(pending, 503);
      page.emit("requestfinished", pending);
      page.emit("requestfailed", pendingFailure);
      const late = request("/private-late");
      page.emit("request", late);
      page.emit("requestfinished", late);
    },
  };
}

describe("privacy-safe performance evidence", () => {
  it("captures a late native LCP after complete-data marks while the image is still loading", async () => {
    const imageRequested = Promise.withResolvers();
    let imageResponse;
    const server = createServer((request, response) => {
      if (request.url === "/late.png") {
        imageResponse = response;
        imageRequested.resolve();
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(`<html><body><h1>Billing ready</h1><img src="/late.png" width="512" height="512"><script>
        requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const stage of ["navigation.started", "visible.shell", "visible.identity", "visible.useful", "visible.complete"])
            performance.mark("koaryu." + stage, { detail: { route: "billing", identity_generation: 1, navigation_generation: 1 } });
        }));
      </script></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    let capture;
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const origin = `http://127.0.0.1:${server.address().port}`;
      capture = captureDashboardPerformance({ route: "billing", frontendOrigin: origin, backendApi: origin + "/api/v1", storageState: "/unused-test-state" }, {
        verifyDeployment: async () => ({ verified: true, expected_sha: "a".repeat(40), environment: "staging" }),
        launchBrowser: async () => ({ newContext: async () => ({ newPage: async () => page }), version: () => browser.version(), close: async () => {} }),
      });
      let settled = false;
      capture.then(() => { settled = true; }, () => { settled = true; });
      await imageRequested.promise;
      await page.waitForFunction(() => performance.getEntriesByName("koaryu.visible.complete").length && globalThis.__koaryuEvidence?.lcp !== null);
      const earlyLcp = await page.evaluate(() => globalThis.__koaryuEvidence.lcp);
      await delay(WEB_VITALS_STABILIZATION.quiet_window_ms + 100);
      assert.equal(settled, false, "an unfinished image must prevent even a quiet early LCP from being accepted");
      imageResponse.setHeader("Content-Type", "image/png");
      imageResponse.end(readFileSync(new URL("../public/icons/icon-512.png", import.meta.url)));
      const evidence = await capture;
      assert.ok(evidence.web_vitals.largest_contentful_paint_ms > earlyLcp);
      assert.ok(evidence.web_vitals.largest_contentful_paint_ms > evidence.selected_required_data_ms);
      assert.deepEqual(evidence.web_vitals.observation, { status: "stabilized", ...WEB_VITALS_STABILIZATION });
      assert.equal(evidence.requests.filter((entry) => entry.initiator === "image" && entry.outcome === "complete").length, 1);
    } finally {
      imageResponse?.destroy();
      await browser.close();
      await capture?.catch(() => {});
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("bounds visual stabilization and rejects instead of returning an early metric", async () => {
    const started = performance.now();
    const page = { evaluate: async () => ({ ready: false, image_failed: false, lcp: 1, cls: 0 }) };
    await assert.rejects(stabilizeWebVitals(page, () => ({ pending: 1, revision: 1 }), { timeout_ms: 100, quiet_window_ms: 20 }), /stabilization timed out/);
    assert.ok(performance.now() - started < 1_000);
    await assert.rejects(stabilizeWebVitals({ evaluate: () => new Promise(() => {}) }, () => ({ pending: 0, revision: 0 }), { timeout_ms: 100, quiet_window_ms: 20 }), /stabilization timed out/);
    await assert.rejects(stabilizeWebVitals({ evaluate: async () => ({ image_failed: true }) }, () => ({ pending: 0, revision: 1 })), /visible image decoding failed/);
  });

  it("restarts the quiet interval for a later LCP and a rendering request between samples", async () => {
    let reads = 0;
    let revision = 0;
    const started = performance.now();
    const result = await stabilizeWebVitals({ evaluate: async () => {
      reads += 1;
      if (reads === 2) revision += 1;
      return { ready: true, image_failed: false, lcp: reads >= 3 ? 30 : 1, cls: 0 };
    } }, () => ({ pending: 0, revision }), { timeout_ms: 1_000, quiet_window_ms: 60 });
    assert.equal(result.status, "stabilized");
    assert.ok(reads >= 5);
    assert.ok(performance.now() - started >= 160);
  });

  it("freezes an exhaustive request inventory before deferred size lookups settle", async () => {
    const fixture = deferredCapture();
    await fixture.snapshotWait;
    fixture.finishDuringSnapshot();
    fixture.sizes.resolve({ responseBodySize: 123 });
    const evidence = await fixture.capture;
    fixture.lateSizes.resolve({ responseBodySize: 999 });

    assert.equal(evidence.requests.length, 4);
    const completed = evidence.requests.filter((entry) => entry.outcome === "complete");
    const pending = evidence.requests.filter((entry) => entry.outcome === "pending-at-capture");
    const failed = evidence.requests.filter((entry) => entry.outcome === "failed");
    assert.deepEqual(pending.map((entry) => [entry.resource, entry.status]), [["other", 202], ["dashboard-summary", 0]]);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].resource, "dashboard-bootstrap");
    assert.equal(completed[0].response_body_bytes, 123);
    assert.equal(completed[0].status, 200);
    assert.equal(typeof completed[0].end_ms, "number");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, 0);
    assert.equal(pending.length, 2);
    assert.equal(pending[0].observed_until_ms, pending[1].observed_until_ms);
    for (const entry of pending) {
      assert.equal(entry.end_ms, null);
      assert.equal(entry.response_body_bytes, 0);
    }
    for (const entry of evidence.requests) {
      assert.deepEqual(Object.keys(entry).sort(), ["route", "navigation_generation", "resource", "initiator", "outcome", "status", "response_body_bytes", "start_ms", "end_ms", "observed_until_ms"].sort());
      assert.equal(entry.route, "billing");
      assert.equal(entry.navigation_generation, 1);
    }
    assert.doesNotMatch(JSON.stringify(evidence), /private|email|secret/);
    assert.deepEqual(fixture.state(), { closed: true, verifications: 2, lateSizeCalls: 0 });
  });

  it("rejects failed size collection instead of returning incomplete request evidence", async () => {
    const fixture = deferredCapture();
    const rejected = assert.rejects(fixture.capture, /size collection failed/);
    await fixture.snapshotWait;
    fixture.sizes.reject(new Error("size collection failed"));
    await rejected;
    assert.deepEqual(fixture.state(), { closed: true, verifications: 1, lateSizeCalls: 0 });
  });

  it("separates identity-scoped shell readiness from aggregate data readiness", () => {
    assert.match(homeSource, /data-koaryu-dashboard-shell-ready=\{layoutResolved \? "true" : "false"\}/);
    assert.match(homeSource, /data-koaryu-dashboard-data-ready=\{layoutResolved && dataReady \? "true" : "false"\}/);
    assert.match(homeSource, /data-koaryu-dashboard-ready=\{layoutResolved \? "true" : "false"\}/);
    assert.match(homeSource, /const layoutResolved = identityReady && identityScope !== null && resolvedLayoutScope === identityScope/);
    assert.match(homeSource, /readDashboardLayout\([\s\S]*setResolvedLayoutScope\(identityScope\)/);
    assert.match(controllerSource, /isDashboardDataReady: datasetReadiness\.status === "ready"/);
    assert.match(captureSource, /data-koaryu-dashboard-data-ready="true"/);
    assert.doesNotMatch(captureSource, /data-koaryu-dashboard-ready="true"/);
  });

  it("verifies the exact SHA before launching a browser", async () => {
    const order = [];
    const browser = {};
    const result = await openVerifiedBrowser({ expectedSha: "a".repeat(40) }, {
      verifyDeployment: async () => {
        order.push("verify");
        return { verified: true };
      },
      launchBrowser: async () => {
        order.push("launch");
        return browser;
      },
    });

    assert.deepEqual(order, ["verify", "launch"]);
    assert.equal(result.browser, browser);
  });

  it("does not launch when exact-SHA verification fails", async () => {
    let launched = false;
    await assert.rejects(openVerifiedBrowser({}, {
      verifyDeployment: async () => { throw new Error("SHA mismatch"); },
      launchBrowser: async () => { launched = true; },
    }), /SHA mismatch/);
    assert.equal(launched, false);
  });

  it("does not launch when verification returns an unsuccessful result", async () => {
    let launched = false;
    await assert.rejects(openVerifiedBrowser({}, {
      verifyDeployment: async () => ({ verified: false }),
      launchBrowser: async () => { launched = true; },
    }), /verification did not succeed/);
    assert.equal(launched, false);
  });

  it("retains only allowlisted route labels and numeric server timing", () => {
    assert.equal(
      classifyResource("https://koaryu.app/api/proxy/dashboard/bootstrap?studio=private"),
      "dashboard-bootstrap",
    );
    assert.equal(classifyResource("https://koaryu.app/api/support/tickets/private"), null);
    assert.deepEqual(sanitizeServerTiming(
      "koaryu_summary_context;dur=2, koaryu_summary_facts;dur=3, koaryu_summary_total;dur=12.4, private;desc=customer@example.test, customer_123;dur=9",
    ), [
      { name: "koaryu_summary_context", duration_ms: 2 },
      { name: "koaryu_summary_facts", duration_ms: 3 },
      { name: "koaryu_summary_total", duration_ms: 12.4 },
    ]);
  });

  it("requires a ready dashboard, both successful resources, finite metrics, and zero blocks", () => {
    const evidence = {
      dashboard_shell_ready_ms: 8,
      dashboard_ready_ms: 10,
      blocked_requests: { write_methods: 0, unknown_origins: 0 },
      navigation: { dom_content_loaded_ms: 4, load_event_ms: 8 },
      web_vitals: {
        first_contentful_paint_ms: 3,
        largest_contentful_paint_ms: 7,
        cumulative_layout_shift: 0,
      },
      resources: [
        { resource: "dashboard-bootstrap", duration_ms: 2, response_start_ms: 1, transfer_bytes: 0 },
        { resource: "dashboard-summary", duration_ms: 3, response_start_ms: 2, transfer_bytes: 0 },
      ],
      server_timing: [
        {
          resource: "dashboard-bootstrap",
          status: 200,
          server_timing: [{ name: "koaryu_total", duration_ms: 1.5 }],
        },
        {
          resource: "dashboard-summary",
          status: 200,
          server_timing: [{ name: "koaryu_summary_total", duration_ms: 2.5 }],
        },
      ],
    };

    assert.equal(validateCapturedEvidence(evidence), evidence);
    assert.throws(
      () => validateCapturedEvidence({
        ...evidence,
        blocked_requests: { write_methods: 0, unknown_origins: 1 },
      }),
      /blocked writes or unknown origins/,
    );
    assert.throws(
      () => validateCapturedEvidence({
        ...evidence,
        web_vitals: { ...evidence.web_vitals, largest_contentful_paint_ms: Number.NaN },
      }),
      /finite and nonnegative/,
    );
    assert.throws(
      () => validateCapturedEvidence({
        ...evidence,
        server_timing: evidence.server_timing.filter((entry) => entry.resource !== "dashboard-summary"),
      }),
      /missing for dashboard-summary/,
    );
    assert.throws(
      () => validateCapturedEvidence({
        ...evidence,
        server_timing: evidence.server_timing.map((entry) => (
          entry.resource === "dashboard-summary" ? { ...entry, status: 500 } : entry
        )),
      }),
      /HTTP 200 responses/,
    );
    assert.throws(
      () => validateCapturedEvidence({
        ...evidence,
        server_timing: evidence.server_timing.map((entry) => (
          entry.resource === "dashboard-summary" ? { ...entry, status: 204 } : entry
        )),
      }),
      /HTTP 200 responses/,
    );
    assert.throws(
      () => validateCapturedEvidence({
        ...evidence,
        server_timing: evidence.server_timing.map((entry) => (
          entry.resource === "dashboard-bootstrap" ? { ...entry, server_timing: [] } : entry
        )),
      }),
      /missing for dashboard-bootstrap/,
    );
    assert.throws(
      () => validateCapturedEvidence({
        ...evidence,
        server_timing: evidence.server_timing.map((entry) => (
          entry.resource === "dashboard-summary"
            ? { ...entry, server_timing: [{ name: "koaryu_summary_total", duration_ms: Infinity }] }
            : entry
        )),
      }),
      /missing for dashboard-summary/,
    );
  });

  it("reads committed marks from the current route generation rather than observer wait duration", async () => {
    const events = [];
    const marks = ["navigation.started", "visible.shell", "visible.identity", "visible.useful", "visible.complete", "visible.legacy-complete"].map((stage, index) => ({ name: `koaryu.${stage}`, startTime: index * 10, detail: { route: "dashboard", identity_generation: 2, navigation_generation: 3 } }));
    const page = {
      locator: (selector) => ({ waitFor: async ({ state }) => { events.push({ selector, state }); } }),
      waitForFunction: async () => {},
      evaluate: async () => marks,
    };
    const readiness = await measureDashboardReady(page);
    assert.equal(readiness.dashboardShellReadyMs, 10);
    assert.equal(readiness.identityReadyMs, 20);
    assert.equal(readiness.usefulReadyMs, 30);
    assert.equal(readiness.dashboardReadyMs, 50);
    assert.equal(readiness.selectedRequiredDataMs, 40);
    assert.equal(events[0].state, "visible");
    marks.pop();
    await assert.rejects(measureDashboardReady(page), /readiness evidence is incomplete/);
    const functional = await measureDashboardReady(page, "dashboard", { functional: true });
    assert.equal(functional.dashboardReadyMs, null);
    assert.equal(functional.selectedRequiredDataMs, 40);
    marks.pop();
    await assert.rejects(measureDashboardReady(page), /readiness evidence is incomplete/);
  });

  it("rejects an alias race when the post-capture release identity changes", async () => {
    await assert.rejects(
      verifyPostCaptureRelease(
        {},
        { verified: true, environment: "production", expected_sha: "a".repeat(40) },
        async () => ({ verified: true, environment: "production", expected_sha: "b".repeat(40) }),
      ),
      /changed during performance capture/,
    );
  });
});
