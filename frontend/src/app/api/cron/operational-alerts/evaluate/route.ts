import {
  sendDeadManCheckIn,
  validateDeadManCheckInConfiguration,
} from "../../../../../lib/dead-man-check-in.ts";
import { configuredBackendApiBase } from "../../../../../lib/backend-api-target.ts";
import { isSafeHeaderSecret } from "../../../../../lib/header-secret.ts";
import {
  parsePinnedJson,
  pinnedHttpsRequest,
} from "../../../../../lib/pinned-https.ts";

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
    || deliveriesFailed !== 0
    || deliveriesClaimed !== deliveriesDelivered
    || body.heartbeat_recorded !== true
    || heartbeatSequence < 1
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

export async function handleOperationalAlertCron(
  request: Request,
  {
    httpsRequest = pinnedHttpsRequest,
    deadManSender = sendDeadManCheckIn,
  }: {
    httpsRequest?: typeof pinnedHttpsRequest;
    deadManSender?: typeof sendDeadManCheckIn;
  } = {},
) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  if (!isSafeHeaderSecret(cronSecret) || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
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
    !isSafeHeaderSecret(workerSecret, 32)
    || workerSecret === "long-random-secret-for-operational-alert-evaluation"
  ) {
    return response({ detail: "Operational alert worker secret is not configured." }, 500);
  }
  const backendBase = configuredBackendApiBase(deploymentEnvironment);
  if (!backendBase) {
    return response({ detail: "Backend API URL is not configured." }, 500);
  }

  try {
    const upstream = await httpsRequest({
      url: `${backendBase}/internal/operational-alerts/evaluate`,
      method: "POST",
      headers: { "X-Internal-Secret": workerSecret },
      timeoutMs: 20_000,
      maxResponseBytes: 64 * 1024,
    });
    const summary = safeUpstreamSummary(
      parsePinnedJson(upstream),
      deploymentEnvironment,
    );
    if (upstream.status < 200 || upstream.status >= 300 || !summary) {
      return response(
        { detail: "Operational alert evaluator did not return a safe successful result." },
        upstream.status >= 200 && upstream.status < 300 ? 502 : upstream.status,
      );
    }
    await deadManSender({
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

export async function GET(request: Request) {
  return handleOperationalAlertCron(request);
}
