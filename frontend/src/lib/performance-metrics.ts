export const METRIC_ROUTES = [
  "dashboard",
  "students",
  "schedule",
  "billing",
  "settings",
  "leads",
  "reports",
  "belt-tracker",
  "public",
  "other",
] as const;
export const METRIC_NAMES = [
  "navigation_commit",
  "navigation_useful",
  "navigation_complete",
  "navigation_failure",
  "LCP",
  "INP",
  "CLS",
] as const;
export type PerformanceMetric = {
  route: (typeof METRIC_ROUTES)[number];
  name: (typeof METRIC_NAMES)[number];
  value: number;
  navigation: "document" | "link" | "history" | "resume";
  outcome: "success" | "timeout" | "redirect" | "interrupted" | "superseded";
};
export type MetricBatch = { version: string; events: PerformanceMetric[] };

export function metricRoute(path: string): PerformanceMetric["route"] {
  if (path === "/") return "public";
  const route = path.replace(/^\//, "");
  return METRIC_ROUTES.includes(route as PerformanceMetric["route"])
    ? (route as PerformanceMetric["route"])
    : "other";
}

export function parseMetricBatch(value: unknown): MetricBatch | null {
  if (!value || typeof value !== "object") return null;
  const batch = value as Record<string, unknown>;
  if (
    Object.keys(batch).some((key) => !["version", "events"].includes(key)) ||
    typeof batch.version !== "string" ||
    !/^[0-9a-f]{40}$/.test(batch.version) ||
    !Array.isArray(batch.events) ||
    !batch.events.length ||
    batch.events.length > 10
  )
    return null;
  for (const event of batch.events) {
    if (
      !event ||
      typeof event !== "object" ||
      Object.keys(event).length !== 5 ||
      !METRIC_ROUTES.includes(event.route) ||
      !METRIC_NAMES.includes(event.name) ||
      !["document", "link", "history", "resume"].includes(event.navigation) ||
      !["success", "timeout", "redirect", "interrupted", "superseded"].includes(event.outcome) ||
      typeof event.value !== "number" ||
      !Number.isFinite(event.value) ||
      event.value < 0 ||
      event.value > (event.name === "CLS" ? 10 : 180_000)
    )
      return null;
  }
  return batch as MetricBatch;
}
