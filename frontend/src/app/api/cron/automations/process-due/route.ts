import {
  boundedLocalBackendRequest,
  configuredBackendApiBase,
} from "../../../../../lib/backend-api-target.ts";
import { isSafeHeaderSecret } from "../../../../../lib/header-secret.ts";
import { parsePinnedJson, pinnedHttpsRequest } from "../../../../../lib/pinned-https.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 10;
const MAX_BATCHES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const LOCAL_BUDGET_MS = 55_000;
const COUNT_KEYS = [
  "enqueued",
  "processed",
  "accepted",
  "retry_wait",
  "failed",
  "unknown",
  "skipped",
] as const;
type WorkerSummary = Record<(typeof COUNT_KEYS)[number], number> & { has_more: boolean };

function response(body: object, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store, private" },
  });
}

function safeWorkerSummary(value: unknown): WorkerSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== COUNT_KEYS.length + 1 ||
    !Object.hasOwn(body, "has_more") ||
    typeof body.has_more !== "boolean" ||
    COUNT_KEYS.some(
      (key) =>
        !Object.hasOwn(body, key) ||
        typeof body[key] !== "number" ||
        !Number.isSafeInteger(body[key]) ||
        body[key] < 0 ||
        body[key] > BATCH_LIMIT,
    )
  ) {
    return null;
  }
  const summary = body as WorkerSummary;
  // Every processed row contributes one outcome, including skips and unknown sends.
  // Enqueueing and processing are independent because an older queue may exist.
  if (
    summary.processed !==
    summary.accepted + summary.retry_wait + summary.failed + summary.unknown + summary.skipped
  ) {
    return null;
  }
  return summary;
}

function safeWorkerSecret(value: string) {
  return (
    isSafeHeaderSecret(value, 32) &&
    /^[\x21-\x7e]+$/.test(value) &&
    !/placeholder|your-|your_|_your|example|change-me|changeme|replace-me|todo|[<>]/i.test(value) &&
    !/^long-random-secret(?:-|$)/i.test(value)
  );
}

export async function handleAutomationCron(
  request: Request,
  {
    httpsRequest = pinnedHttpsRequest,
    localRequest = boundedLocalBackendRequest,
    now = () => performance.now(),
  }: {
    httpsRequest?: typeof pinnedHttpsRequest;
    localRequest?: typeof boundedLocalBackendRequest;
    now?: () => number;
  } = {},
) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  if (
    !isSafeHeaderSecret(cronSecret) ||
    request.headers.get("authorization") !== `Bearer ${cronSecret}`
  ) {
    return response({ detail: "Unauthorized cron request." }, 401);
  }

  if (process.env.AUTOMATION_WORKER_ENABLED !== "true") {
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store, private" },
    });
  }

  const deadline = now() + LOCAL_BUDGET_MS;
  const environment =
    [process.env.VERCEL_TARGET_ENV, process.env.VERCEL_ENV, process.env.NODE_ENV]
      .map((value) => value?.trim().toLowerCase())
      .find(Boolean) ?? "";
  const backendBase = configuredBackendApiBase(environment);
  if (!backendBase) {
    return response({ detail: "Automation worker configuration is unavailable." }, 500);
  }

  // Bind the exact environment and target before reading or forwarding this secret.
  const workerSecret = process.env.AUTOMATION_WORKER_SECRET ?? "";
  if (!safeWorkerSecret(workerSecret)) {
    return response({ detail: "Automation worker configuration is unavailable." }, 500);
  }

  const backendRequest = backendBase.startsWith("http://") ? localRequest : httpsRequest;
  const totals: WorkerSummary = {
    enqueued: 0,
    processed: 0,
    accepted: 0,
    retry_wait: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    has_more: false,
  };
  let completedBatches = 0;
  try {
    while (completedBatches < MAX_BATCHES && deadline - now() >= REQUEST_TIMEOUT_MS) {
      const upstream = await backendRequest({
        url: `${backendBase}/internal/automations/missed-class/process-due`,
        method: "POST",
        headers: {
          "X-Internal-Secret": workerSecret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: BATCH_LIMIT }),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: 64 * 1024,
      });
      const summary = safeWorkerSummary(parsePinnedJson(upstream));
      if (upstream.status !== 200 || !summary) {
        return response({ detail: "Automation worker did not return a safe result." }, 502);
      }
      for (const key of COUNT_KEYS) totals[key] += summary[key];
      totals.has_more = summary.has_more;
      completedBatches += 1;
      if (
        !summary.has_more ||
        (summary.enqueued === 0 && summary.processed === 0) ||
        summary.retry_wait > 0 ||
        summary.failed > 0 ||
        summary.unknown > 0
      ) {
        break;
      }
    }
  } catch {
    // A lost worker response may follow a committed send. The durable outbox owns retries.
    return response({ detail: "Automation worker request could not be completed." }, 502);
  }
  if (completedBatches === 0) {
    return response({ detail: "Automation worker time budget was exhausted." }, 503);
  }
  return response(totals, 200);
}

export async function GET(request: Request) {
  return handleAutomationCron(request);
}
