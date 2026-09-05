import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  classifyResource,
  measureDashboardReady,
  openVerifiedBrowser,
  sanitizeServerTiming,
  validateCapturedEvidence,
  verifyPostCaptureRelease,
} from "../scripts/capture-dashboard-performance.mjs";

const homeSource = readFileSync(new URL("../src/components/dashboard/dashboard-home.tsx", import.meta.url), "utf8");
const controllerSource = readFileSync(new URL("../src/lib/dashboard-page-controller.ts", import.meta.url), "utf8");
const captureSource = readFileSync(new URL("../scripts/capture-dashboard-performance.mjs", import.meta.url), "utf8");

describe("privacy-safe performance evidence", () => {
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
