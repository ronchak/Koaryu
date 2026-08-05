import type { PinnedHttpsResponse } from "./pinned-https.ts";

export type KoaryuDeploymentEnvironment =
  | "development"
  | "test"
  | "staging"
  | "production";

const STAGING_BACKEND_API = "https://koaryu-staging.onrender.com/api/v1";
const PRODUCTION_BACKEND_API = "https://koaryu.onrender.com/api/v1";
const LOCAL_BACKEND_APIS = new Set([
  "http://127.0.0.1:8001/api/v1",
  "http://localhost:8001/api/v1",
]);
const EXACT_ASCII_WITHOUT_WHITESPACE = /^[\x21-\x7e]+$/;

export type BackendRequestOptions = Readonly<{
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs: number;
  maxResponseBytes: number;
}>;

export function configuredBackendApiBase(environment: string) {
  const raw = process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!raw || !EXACT_ASCII_WITHOUT_WHITESPACE.test(raw)) {
    return null;
  }

  let expected: string | Set<string>;
  if (environment === "staging") {
    expected = STAGING_BACKEND_API;
  } else if (environment === "production") {
    expected = PRODUCTION_BACKEND_API;
  } else if (environment === "development" || environment === "test") {
    expected = LOCAL_BACKEND_APIS;
  } else {
    return null;
  }

  if (
    (typeof expected === "string" && raw !== expected)
    || (expected instanceof Set && !expected.has(raw))
  ) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (
      parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.href !== raw
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return raw;
}

export async function boundedLocalBackendRequest({
  url: rawUrl,
  method = "POST",
  headers,
  body,
  timeoutMs,
  maxResponseBytes,
}: BackendRequestOptions): Promise<PinnedHttpsResponse> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("local backend timeout is invalid");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("local backend response bound is invalid");
  }

  const target = new URL(rawUrl);
  const base = `${target.protocol}//${target.host}/api/v1`;
  if (
    !LOCAL_BACKEND_APIS.has(base)
    || target.username
    || target.password
    || target.search
    || target.hash
    || !target.pathname.startsWith("/api/v1/internal/")
    || target.href !== rawUrl
  ) {
    throw new Error("local backend target is invalid");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method,
      headers,
      body: typeof body === "string" || body === undefined ? body : new Uint8Array(body),
      redirect: "error",
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      throw new Error("local backend response exceeded the safe limit");
    }

    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxResponseBytes) {
        controller.abort();
        throw new Error("local backend response exceeded the safe limit");
      }
      chunks.push(value);
    }
    const bodyBytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bodyBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: bodyBytes,
    };
  } finally {
    clearTimeout(timer);
  }
}
