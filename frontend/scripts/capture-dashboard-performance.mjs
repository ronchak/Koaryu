#!/usr/bin/env node

import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseReleaseVerifierArgs,
  verifyDeployedRelease,
} from "../../scripts/verify-deployed-release.mjs";

const SUPABASE_ORIGINS = Object.freeze({
  production: "https://mimguepumzsgmcaycdsh.supabase.co",
  staging: "https://nxgsektqsgrtyfhawxbc.supabase.co",
});
const SAFE_RESOURCE_PATHS = Object.freeze({
  "/dashboard/bootstrap": "dashboard-bootstrap",
  "/dashboard/summary": "dashboard-summary",
});
const REQUIRED_RESOURCES = new Set(Object.values(SAFE_RESOURCE_PATHS));
const SAFE_SERVER_TIMING_NAMES = new Set([
  "koaryu_studio", "koaryu_students", "koaryu_leads", "koaryu_belts",
  "koaryu_programs", "koaryu_total", "koaryu_route_total",
  "koaryu_summary_student_rows", "koaryu_summary_student_counts",
  "koaryu_summary_lead_counts", "koaryu_summary_schedule_counts",
  "koaryu_summary_belt_counts", "koaryu_summary_inactivity_counts",
  "koaryu_summary_new_student_counts", "koaryu_summary_operational_counts",
  "koaryu_summary_churn_counts", "koaryu_summary_test_readiness",
  "koaryu_summary_billing_counts", "koaryu_summary_setup_flags",
  "koaryu_summary_recent_students", "koaryu_summary_total",
  "koaryu_summary_route_total",
]);

export function sanitizeServerTiming(value) {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).flatMap((entry) => {
    const match = /^([a-z0-9_.-]+);dur=(\d+(?:\.\d+)?)$/i.exec(entry);
    const name = match?.[1].toLowerCase();
    const duration = match?.[2] ? Number(match[2]) : null;
    if (
      !name
      || !SAFE_SERVER_TIMING_NAMES.has(name)
      || !finiteNonnegative(duration)
    ) return [];
    return [{ name, duration_ms: duration }];
  });
}

export function classifyResource(value) {
  let pathname;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return null;
  }
  for (const [suffix, label] of Object.entries(SAFE_RESOURCE_PATHS)) {
    if (pathname.endsWith(suffix)) return label;
  }
  return null;
}

export async function openVerifiedBrowser(options, dependencies) {
  const verification = await dependencies.verifyDeployment(options);
  const browser = await dependencies.launchBrowser();
  return { verification, browser };
}

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function roundRequired(value, name) {
  if (!finiteNonnegative(value)) throw new Error(`${name} must be a finite nonnegative metric.`);
  return Math.round(value * 10) / 10;
}

export function validateCapturedEvidence(evidence) {
  if (
    evidence.blocked_requests.write_methods !== 0
    || evidence.blocked_requests.unknown_origins !== 0
  ) {
    throw new Error("dashboard evidence contains blocked writes or unknown origins.");
  }
  const responseResources = new Set();
  const serverTimingResources = new Set();
  for (const entry of evidence.server_timing) {
    if (!REQUIRED_RESOURCES.has(entry.resource) || entry.status !== 200) {
      throw new Error("dashboard bootstrap and summary must return HTTP 200 responses.");
    }
    responseResources.add(entry.resource);
    if (
      entry.server_timing.some((timing) => (
        SAFE_SERVER_TIMING_NAMES.has(timing.name)
        && finiteNonnegative(timing.duration_ms)
      ))
    ) {
      serverTimingResources.add(entry.resource);
    }
  }
  const timingResources = new Set();
  for (const entry of evidence.resources) {
    if (!REQUIRED_RESOURCES.has(entry.resource)) {
      throw new Error("performance evidence contains an unexpected resource label.");
    }
    for (const [name, value] of Object.entries(entry)) {
      if (name !== "resource" && !finiteNonnegative(value)) {
        throw new Error(`resource metric ${name} must be finite and nonnegative.`);
      }
    }
    timingResources.add(entry.resource);
  }
  for (const resource of REQUIRED_RESOURCES) {
    if (
      !responseResources.has(resource)
      || !timingResources.has(resource)
      || !serverTimingResources.has(resource)
    ) {
      throw new Error(`required successful resource evidence is missing for ${resource}.`);
    }
  }
  const metrics = [
    evidence.dashboard_ready_ms,
    evidence.dashboard_shell_ready_ms,
    evidence.navigation.dom_content_loaded_ms,
    evidence.navigation.load_event_ms,
    evidence.web_vitals.first_contentful_paint_ms,
    evidence.web_vitals.largest_contentful_paint_ms,
    evidence.web_vitals.cumulative_layout_shift,
  ];
  if (!metrics.every(finiteNonnegative)) {
    throw new Error("all required dashboard metrics must be finite and nonnegative.");
  }
  return evidence;
}

export async function verifyPostCaptureRelease(options, initialVerification, verifyDeployment) {
  const verification = await verifyDeployment(options);
  if (
    !verification?.verified
    || verification.expected_sha !== initialVerification.expected_sha
    || verification.environment !== initialVerification.environment
  ) {
    throw new Error("deployed release identity changed during performance capture.");
  }
  return verification;
}

export async function measureDashboardReady(page, startedAt, now = Date.now) {
  await page.locator('[data-koaryu-dashboard-shell-ready="true"]').waitFor({
    state: "attached",
    timeout: 20_000,
  });
  const dashboardShellReadyMs = now() - startedAt;
  await page.locator('[data-koaryu-dashboard-data-ready="true"]').waitFor({
    state: "attached",
    timeout: 20_000,
  });
  const dashboardReadyMs = now() - startedAt;
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  return { dashboardReadyMs, dashboardShellReadyMs };
}

function parseArgs(argv) {
  const releaseArgs = parseReleaseVerifierArgs(argv.filter((_, index) => {
    const previous = argv[index - 1];
    return previous !== "--storage-state" && argv[index] !== "--storage-state";
  }));
  const storageFlag = argv.indexOf("--storage-state");
  const storageState = storageFlag >= 0 ? argv[storageFlag + 1] : undefined;
  if (!storageState || !isAbsolute(storageState)) {
    throw new Error("--storage-state must be an absolute path to an existing authenticated state file.");
  }
  return { ...releaseArgs, storageState };
}

export async function captureDashboardPerformance(options, dependencies = {}) {
  const verifyDeployment = dependencies.verifyDeployment ?? verifyDeployedRelease;
  const launchBrowser = dependencies.launchBrowser ?? (async () => {
    const { chromium } = await import("playwright");
    return chromium.launch({ headless: true });
  });
  const { verification, browser } = await openVerifiedBrowser(options, {
    verifyDeployment,
    launchBrowser,
  });
  const allowedOrigins = new Set([
    options.frontendOrigin,
    new URL(options.backendApi).origin,
    SUPABASE_ORIGINS[verification.environment],
  ]);
  const blocked = { write_methods: 0, unknown_origins: 0 };
  const responseTimings = [];
  let evidence;

  try {
    const context = await browser.newContext({ storageState: options.storageState });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (!new Set(["GET", "HEAD", "OPTIONS"]).has(request.method())) {
        blocked.write_methods += 1;
        return route.abort("blockedbyclient");
      }
      if (!allowedOrigins.has(new URL(request.url()).origin)) {
        blocked.unknown_origins += 1;
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    page.on("response", (response) => {
      const resource = classifyResource(response.url());
      if (!resource) return;
      responseTimings.push({
        resource,
        status: response.status(),
        server_timing: sanitizeServerTiming(response.headers()["server-timing"]),
      });
    });
    await page.addInitScript(() => {
      globalThis.__koaryuEvidence = { cls: 0, lcp: null };
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) globalThis.__koaryuEvidence.lcp = entry.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) globalThis.__koaryuEvidence.cls += entry.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch {}
    });

    const startedAt = Date.now();
    await page.goto(`${options.frontendOrigin}/dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const { dashboardReadyMs, dashboardShellReadyMs } = await measureDashboardReady(page, startedAt);
    if (new URL(page.url()).pathname !== "/dashboard") {
      throw new Error("authenticated storage state did not reach /dashboard.");
    }

    const browserEvidence = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const paints = Object.fromEntries(
        performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime]),
      );
      const resources = performance.getEntriesByType("resource").flatMap((entry) => {
        let path;
        try { path = new URL(entry.name).pathname; } catch { return []; }
        const resource = path.endsWith("/dashboard/bootstrap")
          ? "dashboard-bootstrap"
          : path.endsWith("/dashboard/summary") ? "dashboard-summary" : null;
        return resource ? [{
          resource,
          duration_ms: entry.duration,
          response_start_ms: entry.responseStart,
          transfer_bytes: entry.transferSize,
        }] : [];
      });
      return {
        navigation: navigation ? {
          dom_content_loaded_ms: navigation.domContentLoadedEventEnd,
          load_event_ms: navigation.loadEventEnd,
        } : null,
        first_contentful_paint_ms: paints["first-contentful-paint"] ?? null,
        largest_contentful_paint_ms: globalThis.__koaryuEvidence?.lcp ?? null,
        cumulative_layout_shift: globalThis.__koaryuEvidence?.cls ?? null,
        resources,
      };
    });

    evidence = validateCapturedEvidence({
      schema_version: 2,
      captured_at: new Date().toISOString(),
      environment: verification.environment,
      exact_sha_verified: verification.expected_sha,
      privacy: "allowlisted-aggregate-timings-only",
      dashboard_ready_ms: roundRequired(dashboardReadyMs, "dashboard_ready_ms"),
      dashboard_shell_ready_ms: roundRequired(dashboardShellReadyMs, "dashboard_shell_ready_ms"),
      blocked_requests: blocked,
      navigation: {
        dom_content_loaded_ms: roundRequired(
          browserEvidence.navigation?.dom_content_loaded_ms,
          "dom_content_loaded_ms",
        ),
        load_event_ms: roundRequired(browserEvidence.navigation?.load_event_ms, "load_event_ms"),
      },
      web_vitals: {
        first_contentful_paint_ms: roundRequired(
          browserEvidence.first_contentful_paint_ms,
          "first_contentful_paint_ms",
        ),
        largest_contentful_paint_ms: roundRequired(
          browserEvidence.largest_contentful_paint_ms,
          "largest_contentful_paint_ms",
        ),
        cumulative_layout_shift: roundRequired(
          browserEvidence.cumulative_layout_shift,
          "cumulative_layout_shift",
        ),
      },
      resources: browserEvidence.resources.map((entry) => ({
        resource: entry.resource,
        duration_ms: roundRequired(entry.duration_ms, `${entry.resource}.duration_ms`),
        response_start_ms: roundRequired(entry.response_start_ms, `${entry.resource}.response_start_ms`),
        transfer_bytes: roundRequired(entry.transfer_bytes, `${entry.resource}.transfer_bytes`),
      })),
      server_timing: responseTimings,
    });
  } finally {
    await browser.close();
  }

  await verifyPostCaptureRelease(options, verification, verifyDeployment);
  return evidence;
}

async function main() {
  const evidence = await captureDashboardPerformance(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`Dashboard performance capture failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
