import { NextRequest } from "next/server";

const WORKER_SECRET = process.env.ACCOUNT_DELETION_WORKER_SECRET || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getBackendApiBase() {
  const rawBackendApiBase = process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!rawBackendApiBase) {
    return null;
  }

  try {
    const parsedBackendApiBase = new URL(rawBackendApiBase);
    if (!["https:", "http:"].includes(parsedBackendApiBase.protocol)) {
      return null;
    }
  } catch {
    return null;
  }

  return rawBackendApiBase;
}

function isAuthorized(request: NextRequest) {
  if (!CRON_SECRET) {
    return false;
  }

  return request.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return Response.json({ detail: "Unauthorized cron request." }, { status: 401 });
  }

  if (!WORKER_SECRET) {
    return Response.json({ detail: "Account deletion worker secret is not configured." }, { status: 500 });
  }

  const backendApiBase = getBackendApiBase();
  if (!backendApiBase) {
    return Response.json({ detail: "Backend API URL is not configured." }, { status: 500 });
  }

  const target = new URL(
    "internal/account-deletions/process-due",
    backendApiBase.replace(/\/$/, "") + "/"
  );

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "x-internal-secret": WORKER_SECRET,
      },
      cache: "no-store",
    });

    const body = await upstream.json().catch(() => null);

    return Response.json(body ?? { detail: "Account deletion worker returned no JSON body." }, {
      status: upstream.status,
    });
  } catch (error) {
    console.error("Account deletion cron failed", error);
    return Response.json({ detail: "Could not reach account deletion worker." }, { status: 502 });
  }
}
