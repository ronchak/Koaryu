/**
 * Collector for Content-Security-Policy violation reports.
 *
 * The policy ships in report-only mode, so this endpoint is what makes that
 * mode useful: it turns browser violations into runtime log lines that show
 * which directive would break before the policy is enforced.
 *
 * It is unauthenticated by necessity — browsers send these without credentials
 * — so it accepts a bounded body, logs only the directive and the *origin* of
 * the blocked resource, and never echoes anything back. Full URLs are dropped
 * because document URLs carry query strings, which the support-privacy rules
 * keep out of logs.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REPORT_BYTES = 8_192;
const ACCEPTED_CONTENT_TYPES = [
  "application/csp-report",
  "application/reports+json",
  "application/json",
];

function originOf(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") {
    return "unknown";
  }
  // Keyword values like "inline", "eval", or "data" arrive verbatim.
  if (!raw.includes("://")) {
    return raw.slice(0, 32);
  }
  try {
    return new URL(raw).origin;
  } catch {
    return "unparseable";
  }
}

function summarize(body: unknown): { directive: string; blockedOrigin: string } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const report = "csp-report" in body
    ? (body as Record<string, unknown>)["csp-report"]
    : body;

  if (typeof report !== "object" || report === null) {
    return null;
  }

  const fields = report as Record<string, unknown>;
  const directive = fields["effective-directive"]
    ?? fields["effectiveDirective"]
    ?? fields["violated-directive"]
    ?? fields["violatedDirective"];

  return {
    directive: typeof directive === "string" ? directive.slice(0, 64) : "unknown",
    blockedOrigin: originOf(fields["blocked-uri"] ?? fields["blockedURL"]),
  };
}

export async function POST(request: Request) {
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!ACCEPTED_CONTENT_TYPES.includes(contentType)) {
    return new Response(null, { status: 415 });
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REPORT_BYTES) {
    return new Response(null, { status: 413 });
  }

  const raw = await request.text();
  if (raw.length > MAX_REPORT_BYTES) {
    return new Response(null, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }

  // A reports+json payload is an array of reports; csp-report is a single object.
  const entries = Array.isArray(parsed) ? parsed.slice(0, 10) : [parsed];
  for (const entry of entries) {
    const candidate = typeof entry === "object" && entry !== null && "body" in entry
      ? (entry as Record<string, unknown>).body
      : entry;
    const summary = summarize(candidate);
    if (summary) {
      console.warn(
        `csp-violation directive=${summary.directive} blocked-origin=${summary.blockedOrigin}`,
      );
    }
  }

  return new Response(null, { status: 204 });
}
