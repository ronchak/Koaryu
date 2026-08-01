import type { NextRequest } from "next/server";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  if (!isSafeHeaderSecret(cronSecret)) {
    return false;
  }

  return request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function handleAccountDeletionCron(
  request: NextRequest,
  {
    httpsRequest = pinnedHttpsRequest,
    deadManSender = sendDeadManCheckIn,
  }: {
    httpsRequest?: typeof pinnedHttpsRequest;
    deadManSender?: typeof sendDeadManCheckIn;
  } = {},
) {
  if (!isAuthorized(request)) {
    return Response.json({ detail: "Unauthorized cron request." }, { status: 401 });
  }

  const environment = [
    process.env.VERCEL_TARGET_ENV,
    process.env.VERCEL_ENV,
    process.env.NODE_ENV,
  ].map((value) => value?.trim().toLowerCase()).find(Boolean);
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "";

  const backendApiBase = configuredBackendApiBase(environment ?? "");
  if (!backendApiBase) {
    return Response.json({ detail: "Backend API URL is not configured." }, { status: 500 });
  }

  // Do not read or forward this credential until the deployment environment
  // is bound to one exact Koaryu backend target.
  const workerSecret = process.env.ACCOUNT_DELETION_WORKER_SECRET ?? "";
  if (!isSafeHeaderSecret(workerSecret, 32)) {
    return Response.json({ detail: "Account deletion worker secret is not configured." }, { status: 500 });
  }

  if (process.env.OPERATIONAL_ALERTS_ENABLED === "true") {
    if (!environment || !["development", "test", "staging", "production"].includes(environment)) {
      return Response.json({ detail: "Account deletion dead-man identity was unavailable." }, { status: 500 });
    }
    try {
      validateDeadManCheckInConfiguration({
        workerId: "deletion-worker",
        environment: environment as "development" | "test" | "staging" | "production",
        commitSha,
      });
    } catch {
      return Response.json({ detail: "Account deletion dead-man configuration is incomplete." }, { status: 500 });
    }
  }

  const target = `${backendApiBase}/internal/account-deletions/process-due`;

  try {
    const upstream = await httpsRequest({
      url: target,
      method: "POST",
      headers: {
        "x-internal-secret": workerSecret,
      },
      timeoutMs: 20_000,
      maxResponseBytes: 64 * 1024,
    });

    const body = parsePinnedJson(upstream);

    if (upstream.status >= 200 && upstream.status < 300 && process.env.OPERATIONAL_ALERTS_ENABLED === "true") {
      const sequence = Number(upstream.headers["x-koaryu-heartbeat-sequence"]);
      if (
        !environment
        || !["development", "test", "staging", "production"].includes(environment)
        || !Number.isSafeInteger(sequence)
        || sequence < 1
      ) {
        return Response.json(
          { detail: "Account deletion dead-man identity was unavailable." },
          { status: 502 },
        );
      }
      await deadManSender({
        workerId: "deletion-worker",
        environment: environment as "development" | "test" | "staging" | "production",
        commitSha,
        sequence,
      });
    }

    return Response.json(body ?? { detail: "Account deletion worker returned no JSON body." }, {
      status: upstream.status,
    });
  } catch {
    return Response.json({ detail: "Could not reach account deletion worker." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleAccountDeletionCron(request);
}
