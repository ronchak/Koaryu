import { metricRoute, type PerformanceMetric } from "./performance-metrics.ts";

type Attempt = { route: PerformanceMetric["route"]; navigation: PerformanceMetric["navigation"]; started: number; stages: Set<string> };

/** The clock starts at user intent, before middleware or route loading. */
export function createNavigationTimer(emit: (event: PerformanceMetric) => void, now = () => performance.now()) {
  let active: Attempt | null = null;
  return {
    start(route: PerformanceMetric["route"], navigation: PerformanceMetric["navigation"], started = now()) {
      if (active) emit({ route: active.route, navigation: active.navigation, name: "navigation_failure", value: Math.max(0, now() - active.started), outcome: "superseded" });
      active = { route, navigation, started, stages: new Set() };
    },
    stage(route: string, stage: "commit" | "useful" | "complete") {
      if (!active || active.route !== route || active.stages.has(stage)) return;
      active.stages.add(stage);
      emit({ route: active.route, navigation: active.navigation, name: `navigation_${stage}`, value: Math.max(0, now() - active.started), outcome: "success" });
      if (stage === "complete") active = null;
    },
    fail(outcome: PerformanceMetric["outcome"]) {
      if (!active) return;
      emit({ route: active.route, navigation: active.navigation, name: "navigation_failure", value: Math.max(0, now() - active.started), outcome });
      active = null;
    },
    route() { return active?.route; },
  };
}

let version: string | null = null;
let sampled = false;
const events: PerformanceMetric[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let navigationTimeout: ReturnType<typeof setTimeout> | undefined;

export function configurePerformanceCollection(build: string | null) {
  version = build;
  sampled = process.env.NODE_ENV === "production" && Boolean(build) && Math.random() < 0.1;
}

export function flushPerformanceMetrics() {
  clearTimeout(flushTimer); flushTimer = undefined;
  if (!sampled || !version || !events.length) return;
  const batch = events.splice(0, 10);
  void fetch("/api/performance", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version, events: batch }), keepalive: true, credentials: "same-origin", signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}

export function recordPerformanceMetric(event: PerformanceMetric) {
  if (typeof window === "undefined") return;
  try {
    const name = `koaryu.measured.${event.name}`;
    // Keep only the newest measurement of each kind in a long-lived tab.
    performance.clearMarks(name);
    performance.mark(name, { detail: event });
  } catch { /* Measurement never blocks the product. */ }
  if (!sampled) return;
  if (events.length < 10) events.push(event);
  if (events.length === 10) flushPerformanceMetrics();
  else flushTimer ??= setTimeout(flushPerformanceMetrics, 10_000);
}

export const navigationTimer = createNavigationTimer(recordPerformanceMetric);
export function startMeasuredNavigation(path: string, navigation: PerformanceMetric["navigation"], started?: number) {
  const route = metricRoute(path);
  if (route === "public") return;
  navigationTimer.start(route, navigation, started);
  clearTimeout(navigationTimeout);
  navigationTimeout = setTimeout(() => navigationTimer.fail("timeout"), 45_000);
}
export function stopMeasuredNavigation(outcome: PerformanceMetric["outcome"]) {
  clearTimeout(navigationTimeout);
  navigationTimer.fail(outcome);
}
