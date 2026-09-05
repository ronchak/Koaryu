export const CAPTURE_ROUTES = Object.freeze({ dashboard: "/dashboard", students: "/students", schedule: "/schedule", billing: "/billing", settings: "/settings", leads: "/leads" });
const PROVIDER_REFRESH_READS = new Set(["/billing/landing", "/billing/connect/status", "/billing/system/status", "/platform-billing/status"]);
const MATERIALIZATION_PATHS = new Set(["/schedule/window/materialize", "/schedule/sessions/materialize"]);
export function apiPath(path) {
  return path.replace(/^\/api\/(?:v1|proxy)(?=\/)/, "");
}
/** Return only fixed diagnostic categories; never return a URL or request data. */
export function blockedRequestCategory({ url, method }, { allowedOrigins, frontendOrigin, backendOrigin, supabaseOrigin, functional = false }) {
  let parsed;
  try { parsed = new URL(url); } catch { return "unknown_origins"; }
  if (!allowedOrigins.has(parsed.origin)) return "unknown_origins";
  const path = apiPath(parsed.pathname);
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (!functional && PROVIDER_REFRESH_READS.has(path)) return "provider_refresh_reads";
    return null;
  }
  if (functional && method === "POST") {
    if (parsed.origin === supabaseOrigin && parsed.pathname === "/auth/v1/token" && parsed.searchParams.get("grant_type") === "refresh_token") return null;
    if ([frontendOrigin, backendOrigin].includes(parsed.origin) && MATERIALIZATION_PATHS.has(path)) return null;
  }
  return "write_methods";
}
export function validateFunctionalCapture(options) {
  if (options.environment !== "staging" || options.disposableData !== true) {
    throw new Error("functional capture requires exact verified staging and --disposable-data; production is unsupported.");
  }
}
export function sanitizeVisibleMarks(entries, route) {
  const allowed = new Set(["koaryu.navigation.started", "koaryu.visible.shell", "koaryu.visible.identity", "koaryu.visible.useful", "koaryu.visible.complete", "koaryu.visible.legacy-complete"]);
  return entries.flatMap((entry) => {
    const detail = entry.detail;
    if (!allowed.has(entry.name) || !Object.hasOwn(CAPTURE_ROUTES, detail?.route) || detail.route !== route
      || !Number.isSafeInteger(detail.identity_generation) || detail.identity_generation < 0
      || !Number.isSafeInteger(detail.navigation_generation) || detail.navigation_generation < 1
      || !Number.isFinite(entry.startTime) || entry.startTime < 0) return [];
    return [{ stage: entry.name.replace(/^koaryu\.(visible\.)?/, ""), route, identity_generation: detail.identity_generation, navigation_generation: detail.navigation_generation, at_ms: entry.startTime }];
  });
}
