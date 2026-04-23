import { NextRequest } from "next/server";

const BACKEND_API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8001/api/v1";
const ACTIVE_STUDIO_COOKIE = "koaryu-active-studio";
export const runtime = "nodejs";

function buildTargetUrl(request: NextRequest, path: string[]) {
  const requestUrl = new URL(request.url);
  const joinedPath = path.join("/");
  const normalizedBase = BACKEND_API_BASE.replace(/\/$/, "");
  const targetUrl = new URL(`${normalizedBase}/${joinedPath}`);
  targetUrl.search = requestUrl.search;
  return targetUrl;
}

async function createForwardBody(request: NextRequest) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    return await request.formData();
  }

  if (contentType.includes("application/json") || contentType.startsWith("text/")) {
    return await request.text();
  }

  return await request.arrayBuffer();
}

async function forwardRequest(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await context.params;
    const targetUrl = buildTargetUrl(request, path);

    const headers = new Headers();
    const authorization = request.headers.get("authorization");
    const accept = request.headers.get("accept");
    const contentType = request.headers.get("content-type");
    const activeStudioId =
      request.headers.get("x-studio-id") || request.cookies.get(ACTIVE_STUDIO_COOKIE)?.value;

    if (authorization) {
      headers.set("authorization", authorization);
    }

    if (accept) {
      headers.set("accept", accept);
    }

    if (contentType && !contentType.includes("multipart/form-data")) {
      headers.set("content-type", contentType);
    }

    if (activeStudioId) {
      headers.set("x-studio-id", activeStudioId);
    }

    const init: RequestInit = {
      method: request.method,
      headers,
      cache: "no-store",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await createForwardBody(request);
    }

    const upstream = await fetch(targetUrl, init);
    const responseHeaders = new Headers();
    const upstreamContentType = upstream.headers.get("content-type");

    if (upstreamContentType) {
      responseHeaders.set("content-type", upstreamContentType);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("API proxy failed", error);
    return Response.json(
      {
        detail: "Could not reach the backend API. Confirm the backend server is running.",
      },
      { status: 502 }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return forwardRequest(request, context);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return forwardRequest(request, context);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return forwardRequest(request, context);
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return forwardRequest(request, context);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return forwardRequest(request, context);
}
