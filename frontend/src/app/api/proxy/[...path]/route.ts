import { NextRequest } from "next/server";
import { buildPrivateProxyHeaders, buildPrivateProxyJsonHeaders } from "@/lib/proxy-headers";
import { buildUpstreamProxyRequestHeaders } from "@/lib/proxy-request-headers";
import { buildProxyTargetUrl, UnsafeProxyPathError } from "@/lib/proxy-target";
import { ACTIVE_STUDIO_COOKIE } from "@/lib/studio-state-cookie";

const BACKEND_API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8001/api/v1";
export const runtime = "nodejs";

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
    const targetUrl = buildProxyTargetUrl(BACKEND_API_BASE, request.url, path);
    const headers = buildUpstreamProxyRequestHeaders(
      request.headers,
      request.cookies.get(ACTIVE_STUDIO_COOKIE)?.value
    );

    const init: RequestInit = {
      method: request.method,
      headers,
      cache: "no-store",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await createForwardBody(request);
    }

    const upstream = await fetch(targetUrl, init);
    const responseHeaders = buildPrivateProxyHeaders(upstream.headers);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof UnsafeProxyPathError) {
      return Response.json(
        { detail: "Invalid API proxy path." },
        { status: 400, headers: buildPrivateProxyJsonHeaders() }
      );
    }

    console.error("API proxy failed", error);

    return Response.json(
      {
        detail: "Could not reach the backend API. Confirm the backend server is running.",
      },
      { status: 502, headers: buildPrivateProxyJsonHeaders() }
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
