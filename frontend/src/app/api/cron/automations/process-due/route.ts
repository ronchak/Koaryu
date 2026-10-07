import {
  boundedLocalBackendRequest,
  configuredBackendApiBase,
} from "../../../../../lib/backend-api-target.ts";
import { isSafeHeaderSecret } from "../../../../../lib/header-secret.ts";
import { parsePinnedJson, pinnedHttpsRequest } from "../../../../../lib/pinned-https.ts";

import type { ApiAutomationBatchResponse as AutomationBatchResponse } from "../../../../../types/generated/api-contracts.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 10;
const MAX_BATCHES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const LOCAL_BUDGET_MS = 55_000;
const OUTCOME_KEYS = ["accepted", "retry_wait", "failed", "unknown", "skipped"] as const;
const ATTENDANCE_KEYS = ["enqueued", "processed", ...OUTCOME_KEYS] as const;
const WORKFLOW_KEYS = ["claimed", "processed", ...OUTCOME_KEYS, "completed", "waiting"] as const;
function response(body: object, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store, private" },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeCounters<K extends string>(
  value: unknown,
  keys: readonly K[],
  limit: number,
): value is Record<K, number> & { has_more: boolean } {
  if (!record(value)) return false;
  return (
    Object.keys(value).length === keys.length + 1 &&
    Object.hasOwn(value, "has_more") &&
    typeof value.has_more === "boolean" &&
    keys.every(
      (key) =>
        Object.hasOwn(value, key) &&
        typeof value[key] === "number" &&
        Number.isSafeInteger(value[key]) &&
        value[key] >= 0 &&
        value[key] <= limit,
    )
  );
}

function safeWorkerSummary(value: unknown): AutomationBatchResponse | null {
  if (
    !record(value) ||
    Object.keys(value).length !== 4 ||
    !["occurrences", "attendance", "workflows", "has_more"].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    typeof value.has_more !== "boolean" ||
    !safeCounters(value.occurrences, ["created_event_count", "enqueued_run_count"], 25)
  )
    return null;
  const { occurrences, attendance, workflows } = value;
  if (attendance !== null) {
    if (
      !safeCounters(attendance, ATTENDANCE_KEYS, BATCH_LIMIT) ||
      attendance.processed !== OUTCOME_KEYS.reduce((sum, key) => sum + attendance[key], 0)
    )
      return null;
  }
  if (workflows !== null) {
    if (
      !safeCounters(workflows, WORKFLOW_KEYS, BATCH_LIMIT) ||
      workflows.processed > workflows.claimed ||
      workflows.processed !==
        OUTCOME_KEYS.reduce((sum, key) => sum + workflows[key], 0) +
          workflows.completed +
          workflows.waiting
    )
      return null;
  }
  if (
    value.has_more !==
    (occurrences.has_more ||
      attendance === null ||
      attendance.has_more ||
      workflows === null ||
      workflows.has_more)
  )
    return null;
  return { occurrences, attendance, workflows, has_more: value.has_more };
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
  const batches: AutomationBatchResponse[] = [];
  try {
    while (batches.length < MAX_BATCHES && deadline - now() >= REQUEST_TIMEOUT_MS) {
      const upstream = await backendRequest({
        url: `${backendBase}/internal/automations/process-due`,
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
      batches.push(summary);
      const { occurrences, attendance, workflows } = summary;
      const progress =
        occurrences.created_event_count > 0 ||
        occurrences.enqueued_run_count > 0 ||
        (attendance !== null && (attendance.enqueued > 0 || attendance.processed > 0)) ||
        (workflows !== null && workflows.processed > 0);
      const uncertain = [attendance, workflows].some(
        (engine) =>
          engine !== null && (engine.retry_wait > 0 || engine.failed > 0 || engine.unknown > 0),
      );
      if (!summary.has_more || !progress || uncertain) {
        break;
      }
    }
  } catch {
    // A lost worker response may follow a committed send. The durable outbox owns retries.
    return response({ detail: "Automation worker request could not be completed." }, 502);
  }
  if (batches.length === 0) {
    return response({ detail: "Automation worker time budget was exhausted." }, 503);
  }
  return response({ batches, has_more: batches[batches.length - 1].has_more }, 200);
}

export async function GET(request: Request) {
  return handleAutomationCron(request);
}
