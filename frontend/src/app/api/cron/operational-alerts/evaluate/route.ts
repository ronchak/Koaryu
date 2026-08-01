import {
  sendDeadManCheckIn,
  validateDeadManCheckInConfiguration,
} from "../../../../../lib/dead-man-check-in.ts";

const ALLOWED_RULE_IDS = new Set([
  "stripe-live-webhook-failure",
  "account-deletion-worker-overdue",
  "support-urgent-untriaged",
  "billing-reconciliation-stale",
]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(body: object, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store, private" },
  });
}

const STAGING_BACKEND_API = "https://koaryu-staging.onrender.com/api/v1";
const PRODUCTION_BACKEND_API = "https://koaryu.onrender.com/api/v1";
const LOCAL_BACKEND_APIS = new Set([
  "http://127.0.0.1:8001/api/v1",
  "http://localhost:8001/api/v1",
]);

function configuredBackendBase(environment: string) {
  const raw = process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!raw || raw !== raw.trim()) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    const normalized = raw.replace(/\/$/, "");
    if (environment === "staging") {
      return normalized === STAGING_BACKEND_API ? normalized : null;
    }
    if (environment === "production") {
      return normalized === PRODUCTION_BACKEND_API ? normalized : null;
    }
    if (["development", "test"].includes(environment)) {
      return LOCAL_BACKEND_APIS.has(normalized) ? normalized : null;
    }
    return null;
  } catch {
    return null;
  }
}

function safeUpstreamSummary(value: unknown, expectedEnvironment: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    body.environment !== expectedEnvironment
    || body.mode !== "https"
    || typeof body.metrics !== "object"
    || body.metrics === null
    || Array.isArray(body.metrics)
  ) {
    return null;
  }
  const metrics = Object.fromEntries(
    Object.entries(body.metrics as Record<string, unknown>).filter(
      ([ruleId, count]) => ALLOWED_RULE_IDS.has(ruleId)
        && typeof count === "number"
        && Number.isSafeInteger(count)
        && count >= 0,
    ),
  );
  if (Object.keys(metrics).length !== ALLOWED_RULE_IDS.size) {
    return null;
  }
  const integer = (name: string) => typeof body[name] === "number"
    && Number.isSafeInteger(body[name])
    && Number(body[name]) >= 0
    ? Number(body[name])
    : null;
  const deliveriesClaimed = integer("deliveries_claimed");
  const deliveriesDelivered = integer("deliveries_delivered");
  const deliveriesFailed = integer("deliveries_failed");
  const heartbeatSequence = integer("heartbeat_sequence");
  if (
    deliveriesClaimed === null
    || deliveriesDelivered === null
    || deliveriesFailed === null
    || heartbeatSequence === null
  ) {
    return null;
  }
  return {
    environment: String(body.environment),
    mode: "https",
    metrics,
    deliveries_claimed: deliveriesClaimed,
    deliveries_delivered: deliveriesDelivered,
    deliveries_failed: deliveriesFailed,
    heartbeat_recorded: body.heartbeat_recorded === true,
    heartbeat_sequence: heartbeatSequence,
  };
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return response({ detail: "Unauthorized cron request." }, 401);
  }

  if (process.env.OPERATIONAL_ALERTS_ENABLED !== "true") {
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store, private" },
    });
  }

  const deploymentEnvironment = [
    process.env.VERCEL_TARGET_ENV,
    process.env.VERCEL_ENV,
    process.env.NODE_ENV,
  ].map((value) => value?.trim().toLowerCase()).find(Boolean) ?? "";
  if (!["development", "test", "staging", "production"].includes(deploymentEnvironment)) {
    return response({ detail: "Operational alerts require a known environment." }, 503);
  }
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "";
  try {
    validateDeadManCheckInConfiguration({
      workerId: "evaluator",
      environment: deploymentEnvironment as "development" | "test" | "staging" | "production",
      commitSha,
    });
  } catch {
    return response({ detail: "Evaluator dead-man configuration is incomplete." }, 500);
  }

  const workerSecret = process.env.OPERATIONAL_ALERT_WORKER_SECRET ?? "";
  if (
    workerSecret.length < 32
    || workerSecret !== workerSecret.trim()
    || workerSecret === "long-random-secret-for-operational-alert-evaluation"
  ) {
    return response({ detail: "Operational alert worker secret is not configured." }, 500);
  }
  const backendBase = configuredBackendBase(deploymentEnvironment);
  if (!backendBase) {
    return response({ detail: "Backend API URL is not configured." }, 500);
  }

  try {
    const upstream = await fetch(`${backendBase}/internal/operational-alerts/evaluate`, {
      method: "POST",
      headers: { "X-Internal-Secret": workerSecret },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const summary = safeUpstreamSummary(
      await upstream.json().catch(() => null),
      deploymentEnvironment,
    );
    if (!upstream.ok || !summary) {
      return response(
        { detail: "Operational alert evaluator did not return a safe successful result." },
        upstream.ok ? 502 : upstream.status,
      );
    }
    await sendDeadManCheckIn({
      workerId: "evaluator",
      environment: deploymentEnvironment as "development" | "test" | "staging" | "production",
      commitSha,
      sequence: summary.heartbeat_sequence,
    });
    return response(summary, 200);
  } catch {
    return response({ detail: "Could not reach operational alert evaluator." }, 502);
  }
}
