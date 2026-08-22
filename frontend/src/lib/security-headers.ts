/**
 * Baseline security headers for every Koaryu response.
 *
 * The policy is built from environment rather than hardcoded so that staging,
 * preview, and production each allow exactly their own Supabase project and
 * backend origin. An origin that cannot be parsed is dropped instead of being
 * interpolated, so a malformed env value can never widen the policy.
 */

export type SecurityHeaderEnvironment = Readonly<{
  supabaseUrl?: string | null;
  apiUrl?: string | null;
  siteUrl?: string | null;
  nodeEnv?: string | null;
  vercelEnv?: string | null;
}>;

export type HeaderEntry = Readonly<{ key: string; value: string }>;

const DEFAULT_SITE_ORIGIN = "https://koaryu.app";

// The Vercel preview toolbar is injected by the platform, not by our bundle.
const VERCEL_TOOLBAR_ORIGIN = "https://vercel.live";
const VERCEL_TOOLBAR_SOCKET = "wss://ws-us3.pusher.com";

export function resolveOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

export function buildContentSecurityPolicy(env: SecurityHeaderEnvironment): string {
  const isDevelopment = env.nodeEnv === "development";
  const isPreview = env.vercelEnv === "preview";

  const supabaseOrigin = resolveOrigin(env.supabaseUrl);
  const apiOrigin = resolveOrigin(env.apiUrl);

  // Turbopack's HMR client evaluates generated code and holds a dev websocket.
  const devScript = isDevelopment ? ["'unsafe-eval'"] : [];
  const devConnect = isDevelopment ? ["ws:", "http://127.0.0.1:*", "http://localhost:*"] : [];
  const toolbarScript = isPreview ? [VERCEL_TOOLBAR_ORIGIN] : [];
  const toolbarConnect = isPreview ? [VERCEL_TOOLBAR_ORIGIN, VERCEL_TOOLBAR_SOCKET] : [];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // The App Router emits inline bootstrap and flight-chunk scripts on every
    // page, and the anti-FOUC theme script in app/layout.tsx must run before
    // paint. A nonce cannot cover statically prerendered routes, so inline
    // script stays allowed until those routes go dynamic.
    "script-src": ["'self'", "'unsafe-inline'", ...devScript, ...toolbarScript],
    // Inline style="" attributes are server-rendered across the app and a nonce
    // does not whitelist style attributes.
    "style-src": ["'self'", "'unsafe-inline'"],
    // blob: covers local photo previews before upload; the Supabase origin
    // serves the signed student-photo URLs.
    "img-src": unique(["'self'", "data:", "blob:", supabaseOrigin]),
    "font-src": ["'self'"],
    "connect-src": unique([
      "'self'",
      supabaseOrigin,
      apiOrigin,
      ...devConnect,
      ...toolbarConnect,
    ]),
    "media-src": ["'none'"],
    "worker-src": ["'none'"],
    "object-src": ["'none'"],
    "frame-src": isPreview ? [VERCEL_TOOLBAR_ORIGIN] : ["'none'"],
    "manifest-src": ["'self'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };

  const serialized = Object.entries(directives).map(
    ([directive, values]) => `${directive} ${values.join(" ")}`,
  );

  // Only meaningful when every configured origin is already https; a local
  // production build pointed at an http backend would otherwise have its own
  // requests rewritten out from under it.
  const hasPlaintextOrigin = [supabaseOrigin, apiOrigin].some(
    (origin) => origin !== null && origin.startsWith("http://"),
  );
  if (!isDevelopment && !hasPlaintextOrigin) {
    serialized.push("upgrade-insecure-requests");
  }
  serialized.push("report-uri /api/csp-report");

  return serialized.join("; ");
}

export function securityHeaders(env: SecurityHeaderEnvironment): HeaderEntry[] {
  const siteOrigin = resolveOrigin(env.siteUrl) ?? DEFAULT_SITE_ORIGIN;

  return [
    // Report-only while the policy is observed against real traffic. Switching
    // to Content-Security-Policy is the only change needed to enforce it.
    {
      key: "Content-Security-Policy-Report-Only",
      value: buildContentSecurityPolicy(env),
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    },
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    // Vercel serves a wildcard CORS header by default. Nothing cross-origin is
    // meant to read these responses, so narrow it to the site's own origin.
    { key: "Access-Control-Allow-Origin", value: siteOrigin },
  ];
}

export function securityHeadersFromProcessEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
): HeaderEntry[] {
  return securityHeaders({
    supabaseUrl: processEnv.NEXT_PUBLIC_SUPABASE_URL,
    apiUrl: processEnv.NEXT_PUBLIC_API_URL,
    siteUrl: processEnv.NEXT_PUBLIC_SITE_URL,
    nodeEnv: processEnv.NODE_ENV,
    vercelEnv: processEnv.VERCEL_ENV,
  });
}
