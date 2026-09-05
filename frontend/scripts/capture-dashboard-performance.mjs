#!/usr/bin/env node

import { CAPTURE_ROUTES, blockedRequestCategory, sanitizeVisibleMarks, validateFunctionalCapture } from "./performance-capture-policy.mjs";

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
const RENDER_RESOURCE_TYPES = new Set(["document", "script", "stylesheet", "image", "font"]);
export const WEB_VITALS_STABILIZATION = Object.freeze({ timeout_ms: 10_000, quiet_window_ms: 500 });
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
  "koaryu_summary_route_total", "koaryu_summary_context", "koaryu_summary_facts",
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
  if (verification?.verified !== true) throw new Error("exact deployed release verification did not succeed.");
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
    || (evidence.blocked_requests.provider_refresh_reads ?? 0) !== 0
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
  for (const resource of evidence.route && evidence.route !== "dashboard" ? [] : REQUIRED_RESOURCES) {
    if (
      !responseResources.has(resource)
      || !timingResources.has(resource)
      || !serverTimingResources.has(resource)
    ) {
      throw new Error(`required successful resource evidence is missing for ${resource}.`);
    }
  }
  const metrics = [
    evidence.workflow === "disposable-staging-functional" && evidence.dashboard_ready_ms === null ? evidence.selected_required_data_ms : evidence.dashboard_ready_ms,
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

export async function measureDashboardReady(page, route = "dashboard", { functional = false } = {}) {
  // These legacy attributes retain complete-data semantics. They are waits only;
  // timestamps come from marks written after committed UI had a paint opportunity.
  if (route === "dashboard" && !functional) {
    await page.locator('[data-koaryu-dashboard-shell-ready="true"]').waitFor({ state: "visible", timeout: 20_000 });
    await page.locator('[data-koaryu-dashboard-data-ready="true"]').waitFor({ state: "visible", timeout: 20_000 });
  }
  await page.waitForFunction(({ expectedRoute, requireLegacy }) => {
    const started = performance.getEntriesByName("koaryu.navigation.started").filter((entry) => entry.detail?.route === expectedRoute).at(-1);
    return started && performance.getEntriesByName(requireLegacy ? "koaryu.visible.legacy-complete" : "koaryu.visible.complete").some((entry) => entry.detail?.route === expectedRoute && entry.detail.navigation_generation === started.detail.navigation_generation);
  }, { expectedRoute: route, requireLegacy: route === "dashboard" && !functional }, { timeout: 20_000 });
  const entries = await page.evaluate(() => performance.getEntriesByType("mark").map(({ name, startTime, detail }) => ({ name, startTime, detail })));
  const marks = sanitizeVisibleMarks(entries, route);
  const generation = marks.filter((entry) => entry.stage === "navigation.started").at(-1);
  const current = marks.filter((entry) => entry.navigation_generation === generation?.navigation_generation && entry.identity_generation === generation?.identity_generation);
  const at = (stage) => current.find((entry) => entry.stage === stage)?.at_ms;
  const values = [at("shell"), at("identity"), at("useful"), at("complete")];
  if (!values.every(finiteNonnegative) || (route === "dashboard" && !functional && !finiteNonnegative(at("legacy-complete")))) throw new Error("committed route/identity readiness evidence is incomplete.");
  return { neutralShellReadyMs: marks.find((entry) => entry.stage === "shell")?.at_ms ?? at("shell"), dashboardShellReadyMs: at("shell"), dashboardReadyMs: route === "dashboard" ? (at("legacy-complete") ?? null) : at("complete"), selectedRequiredDataMs: at("complete"), identityReadyMs: at("identity"), usefulReadyMs: at("useful"), visibleMarks: marks };
}

export function parseArgs(argv) {
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

function readVisualReadiness() {
  const evidence = globalThis.__koaryuEvidence;
  if (!evidence) throw new Error("browser performance observers are missing.");
  evidence.imageDecodes ??= new WeakMap();
  let imagesReady = true;
  let imageFailed = false;
  for (const image of document.images) {
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth
      || getComputedStyle(image).visibility === "hidden") continue;
    const source = image.currentSrc || image.src;
    if (!source) continue;
    let decode = evidence.imageDecodes.get(image);
    if (!decode || decode.source !== source) {
      decode = { source, ready: false, failed: false };
      evidence.imageDecodes.set(image, decode);
      image.decode().then(() => { decode.ready = true; }, () => { decode.failed = true; });
    }
    imagesReady &&= image.complete && decode.ready;
    imageFailed ||= decode.failed;
  }
  return {
    ready: document.readyState === "complete" && document.fonts.status === "loaded" && imagesReady,
    image_failed: imageFailed,
    lcp: evidence.lcp,
    cls: evidence.cls,
  };
}

export async function stabilizeWebVitals(page, renderRequests, policy = WEB_VITALS_STABILIZATION) {
  const startedAt = performance.now();
  const timeoutError = () => new Error("Web Vitals stabilization timed out; capture has no finalized LCP/CLS evidence.");
  let quietSince = startedAt;
  let previous = null;
  while (performance.now() - startedAt < policy.timeout_ms) {
    let timer;
    let visual;
    try {
      visual = await Promise.race([
        page.evaluate(readVisualReadiness),
        new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), Math.max(0, policy.timeout_ms - (performance.now() - startedAt))); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const requests = renderRequests();
    const now = performance.now();
    if (visual.image_failed) throw new Error("Web Vitals stabilization failed: visible image decoding failed.");
    if (!visual.ready || requests.pending !== 0 || !previous
      || visual.lcp !== previous.lcp || visual.cls !== previous.cls
      || requests.revision !== previous.revision) quietSince = now;
    if (visual.ready && requests.pending === 0 && now - quietSince >= policy.quiet_window_ms
      && now - startedAt < policy.timeout_ms) {
      return { status: "stabilized", timeout_ms: policy.timeout_ms, quiet_window_ms: policy.quiet_window_ms };
    }
    previous = { lcp: visual.lcp, cls: visual.cls, revision: requests.revision };
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, policy.timeout_ms - (performance.now() - startedAt)))));
  }
  throw timeoutError();
}

export async function captureDashboardPerformance(options, dependencies = {}) {
  const routeLabel = options.route ?? "dashboard";
  if (!Object.hasOwn(CAPTURE_ROUTES, routeLabel)) throw new Error("unknown capture route.");
  if (options.functional) validateFunctionalCapture(options);
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
  const blocked = { write_methods: 0, unknown_origins: 0, provider_refresh_reads: 0 };
  const requests = [];
  const requestStarts = new Map();
  const requestCompletions = [];
  const requestStatuses = new Map();
  const responseTimings = [];
  let renderRequestRevision = 0;
  let acceptingRequestEvents = true;
  let evidence;

  try {
    const context = await browser.newContext({ storageState: options.storageState, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const request = route.request();
      const blockedCategory = blockedRequestCategory({ url: request.url(), method: request.method() }, {
        allowedOrigins, frontendOrigin: options.frontendOrigin, backendOrigin: new URL(options.backendApi).origin,
        supabaseOrigin: SUPABASE_ORIGINS[verification.environment], functional: options.functional === true,
      });
      if (blockedCategory) {
        blocked[blockedCategory] += 1;
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const navigationGeneration = 1;
    page.on("request", (request) => {
      if (!acceptingRequestEvents) return;
      if (RENDER_RESOURCE_TYPES.has(request.resourceType())) renderRequestRevision += 1;
      requestStarts.set(request, { started_at_ms: performance.now(), generation: navigationGeneration });
    });
    page.on("requestfinished", (request) => {
      if (!acceptingRequestEvents) return;
      const start = requestStarts.get(request);
      requestStarts.delete(request);
      if (!start) return;
      const endedAt = performance.now();
      const completion = (async () => {
        const sizes = await request.sizes();
        requests.push({ route: routeLabel, navigation_generation: start.generation, resource: classifyResource(request.url()) ?? "other", initiator: ["document", "fetch", "xhr", "script", "stylesheet", "image", "font"].includes(request.resourceType()) ? request.resourceType() : "other", outcome: "complete", status: requestStatuses.get(request) ?? 0, response_body_bytes: sizes.responseBodySize, started_at_ms: start.started_at_ms, ended_at_ms: endedAt });
        requestStatuses.delete(request);
      })();
      // The stabilization window can outlast a rejected lookup. Observe the
      // rejection now; Promise.all below still rejects the capture with it.
      completion.catch(() => {});
      requestCompletions.push(completion);
    });
    page.on("requestfailed", (request) => {
      if (!acceptingRequestEvents) return;
      const start = requestStarts.get(request);
      requestStarts.delete(request);
      if (start) requests.push({ route: routeLabel, navigation_generation: start.generation, resource: classifyResource(request.url()) ?? "other", initiator: "other", outcome: "failed", status: 0, response_body_bytes: 0, started_at_ms: start.started_at_ms, ended_at_ms: performance.now() });
    });
    page.on("response", (response) => {
      if (!acceptingRequestEvents) return;
      requestStatuses.set(response.request(), response.status());
      const resource = classifyResource(response.url());
      if (!resource) return;
      responseTimings.push({
        resource,
        status: response.status(),
        server_timing: sanitizeServerTiming(response.headers()["server-timing"]),
      });
    });
    await page.addInitScript(() => {
      globalThis.__koaryuEvidence = { cls: 0, lcp: null, interactions: [], longTasks: [] };
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
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.interactionId > 0) globalThis.__koaryuEvidence.interactions.push({
              interaction_id: entry.interactionId,
              category: entry.name.startsWith("key") ? "keyboard" : "pointer",
              start_ms: entry.startTime,
              duration_ms: entry.duration,
            });
          }
        }).observe({ type: "event", buffered: true, durationThreshold: 16 });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) globalThis.__koaryuEvidence.longTasks.push({ start_ms: entry.startTime, duration_ms: entry.duration });
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    });

    const captureStartedAt = performance.now();
    await page.goto(`${options.frontendOrigin}${CAPTURE_ROUTES[routeLabel]}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const { dashboardReadyMs, dashboardShellReadyMs, neutralShellReadyMs, identityReadyMs, usefulReadyMs, selectedRequiredDataMs, visibleMarks } = await measureDashboardReady(page, routeLabel, { functional: options.functional === true });
    if (new URL(page.url()).pathname !== CAPTURE_ROUTES[routeLabel]) {
      throw new Error("authenticated storage state did not reach /dashboard.");
    }

    const webVitalsObservation = await stabilizeWebVitals(page, () => ({
      pending: [...requestStarts.keys()].filter((request) => RENDER_RESOURCE_TYPES.has(request.resourceType())).length,
      revision: renderRequestRevision,
    }));
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
        interactions: globalThis.__koaryuEvidence?.interactions ?? [],
        long_tasks: globalThis.__koaryuEvidence?.longTasks ?? [],
      };
    });

    // Close the observation window before awaiting sizes. Otherwise a completion
    // can leave requestStarts after Promise.all has copied its input, disappearing
    // from both the completed and pending inventory.
    acceptingRequestEvents = false;
    const requestSnapshotAt = performance.now();
    for (const [request, start] of requestStarts) {
      requests.push({ route: routeLabel, navigation_generation: start.generation, resource: classifyResource(request.url()) ?? "other", initiator: "other", outcome: "pending-at-capture", status: requestStatuses.get(request) ?? 0, response_body_bytes: 0, started_at_ms: start.started_at_ms, ended_at_ms: requestSnapshotAt });
    }
    await Promise.all(requestCompletions);
    evidence = validateCapturedEvidence({
      schema_version: 3,
      route: routeLabel,
      workflow: options.functional ? "disposable-staging-functional" : "read-only-observation",
      browser_http_cache: "disabled-by-playwright-routing",
      router_cache: "fresh-browser-context",
      backend_fact_cache: "uncontrolled-record-separately",
      server_warmth: "uncontrolled-record-separately",
      browser_version: browser.version(),
      neutral_shell_ready_ms: roundRequired(neutralShellReadyMs, "neutral_shell_ready_ms"),
      identity_ready_ms: roundRequired(identityReadyMs, "identity_ready_ms"),
      first_useful_content_ms: roundRequired(usefulReadyMs, "first_useful_content_ms"),
      visible_marks: visibleMarks,
      requests: requests.map(({ route, navigation_generation, resource, initiator, outcome, status, response_body_bytes, started_at_ms, ended_at_ms }) => ({ route, navigation_generation, resource, initiator, outcome, status, response_body_bytes, start_ms: roundRequired(Math.max(0, started_at_ms - captureStartedAt), "request.start"), end_ms: outcome === "pending-at-capture" ? null : roundRequired(Math.max(0, ended_at_ms - captureStartedAt), "request.end"), observed_until_ms: roundRequired(Math.max(0, ended_at_ms - captureStartedAt), "request.observed_until") })),
      captured_at: new Date().toISOString(),
      environment: verification.environment,
      exact_sha_verified: verification.expected_sha,
      privacy: "allowlisted-aggregate-timings-only",
      dashboard_ready_ms: options.functional && dashboardReadyMs === null ? null : roundRequired(dashboardReadyMs, "dashboard_ready_ms"),
      selected_required_data_ms: roundRequired(selectedRequiredDataMs, "selected_required_data_ms"),
      dashboard_shell_ready_ms: roundRequired(dashboardShellReadyMs, "dashboard_shell_ready_ms"),
      blocked_requests: blocked,
      navigation: {
        dom_content_loaded_ms: roundRequired(
          browserEvidence.navigation?.dom_content_loaded_ms,
          "dom_content_loaded_ms",
        ),
        load_event_ms: roundRequired(browserEvidence.navigation?.load_event_ms, "load_event_ms"),
      },
      interactions: { source: "browser-lab-event-timing-not-field-inp", entries: browserEvidence.interactions },
      browser_long_tasks: browserEvidence.long_tasks,
      web_vitals: {
        observation: webVitalsObservation,
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
