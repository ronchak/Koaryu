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
const SAFE_SERVER_TIMING_NAMES = new Set([
  "koaryu_studio",
  "koaryu_students",
  "koaryu_leads",
  "koaryu_belts",
  "koaryu_programs",
  "koaryu_total",
  "koaryu_route_total",
  "koaryu_summary_student_rows",
  "koaryu_summary_student_counts",
  "koaryu_summary_lead_counts",
  "koaryu_summary_schedule_counts",
  "koaryu_summary_belt_counts",
  "koaryu_summary_inactivity_counts",
  "koaryu_summary_new_student_counts",
  "koaryu_summary_operational_counts",
  "koaryu_summary_churn_counts",
  "koaryu_summary_test_readiness",
  "koaryu_summary_billing_counts",
  "koaryu_summary_setup_flags",
  "koaryu_summary_recent_students",
  "koaryu_summary_total",
  "koaryu_summary_route_total",
]);

export function sanitizeServerTiming(value) {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).flatMap((entry) => {
    const match = /^([a-z0-9_.-]+)(?:;dur=(\d+(?:\.\d+)?))?$/i.exec(entry);
    const name = match?.[1].toLowerCase();
    if (!name || !SAFE_SERVER_TIMING_NAMES.has(name)) return [];
    return [{ name, duration_ms: match[2] ? Number(match[2]) : null }];
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

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
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
  const launchBrowser = dependencies.launchBrowser ?? (async () => {
    const { chromium } = await import("playwright");
    return chromium.launch({ headless: true });
  });
  const { verification, browser } = await openVerifiedBrowser(options, {
    verifyDeployment: dependencies.verifyDeployment ?? verifyDeployedRelease,
    launchBrowser,
  });
  const allowedOrigins = new Set([
    options.frontendOrigin,
    new URL(options.backendApi).origin,
    SUPABASE_ORIGINS[verification.environment],
  ]);
  const blocked = { write_methods: 0, unknown_origins: 0 };
  const responseTimings = [];

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
    await page.locator("main").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const dashboardVisibleMs = Date.now() - startedAt;
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

    if (blocked.write_methods > 0) {
      throw new Error("dashboard attempted a state-changing request; evidence capture was aborted.");
    }
    return {
      schema_version: 1,
      captured_at: new Date().toISOString(),
      environment: verification.environment,
      exact_sha_verified: verification.expected_sha,
      privacy: "allowlisted-aggregate-timings-only",
      dashboard_visible_ms: dashboardVisibleMs,
      blocked_requests: blocked,
      navigation: browserEvidence.navigation && {
        dom_content_loaded_ms: round(browserEvidence.navigation.dom_content_loaded_ms),
        load_event_ms: round(browserEvidence.navigation.load_event_ms),
      },
      web_vitals: {
        first_contentful_paint_ms: round(browserEvidence.first_contentful_paint_ms),
        largest_contentful_paint_ms: round(browserEvidence.largest_contentful_paint_ms),
        cumulative_layout_shift: round(browserEvidence.cumulative_layout_shift),
      },
      resources: browserEvidence.resources.map((entry) => ({
        resource: entry.resource,
        duration_ms: round(entry.duration_ms),
        response_start_ms: round(entry.response_start_ms),
        transfer_bytes: Number.isSafeInteger(entry.transfer_bytes) ? entry.transfer_bytes : null,
      })),
      server_timing: responseTimings,
    };
  } finally {
    await browser.close();
  }
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
