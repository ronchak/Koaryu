import { getActiveStudioIdCookie } from "@/lib/studio-state-cookie";

const SERVER_API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8001/api/v1";
const API_BASE = typeof window === "undefined" ? SERVER_API_BASE : "/api/proxy";
const API_TIMEOUT_MS = 12000;

interface ApiOptions {
  token?: string;
  body?: unknown;
  method?: string;
  headers?: Record<string, string>;
  omitStudioHeader?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  timeoutMessage?: string;
  networkErrorMessage?: string;
}

interface FormApiOptions {
  token?: string;
  method?: string;
  body: FormData;
  headers?: Record<string, string>;
  omitStudioHeader?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  timeoutMessage?: string;
  networkErrorMessage?: string;
}

function formatApiErrorDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim()) {
    return detail;
  }

  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0];
    if (typeof first === "string") {
      return first;
    }
    if (first && typeof first === "object") {
      const record = first as Record<string, unknown>;
      if (typeof record.msg === "string" && record.msg.trim()) {
        return record.msg;
      }
      if (typeof record.message === "string" && record.message.trim()) {
        return record.message;
      }
    }
  }

  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.msg === "string" && record.msg.trim()) {
      return record.msg;
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
    try {
      return JSON.stringify(detail);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

async function parseErrorResponse(res: Response): Promise<string> {
  const fallback = `API error: ${res.status}`;
  const contentType = res.headers.get("content-type") || "";
  const rawText = await res.text();

  if (!rawText) {
    return fallback;
  }

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawText) as { detail?: unknown };
      return formatApiErrorDetail(parsed.detail, fallback);
    } catch {
      return rawText.trim() || fallback;
    }
  }

  return rawText.trim() || fallback;
}

async function parseSuccessResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

function createAbortError(): Error {
  const error = new Error("Request was canceled.");
  error.name = "AbortError";
  return error;
}

async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const {
    token,
    body,
    method = "GET",
    headers: extraHeaders,
    omitStudioHeader = false,
    signal,
    timeoutMs = API_TIMEOUT_MS,
    timeoutMessage = "Request timed out. Please try again.",
    networkErrorMessage = "Failed to reach the backend. Please try again.",
  } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (typeof window !== "undefined" && !omitStudioHeader) {
    const activeStudioId = getActiveStudioIdCookie();
    if (activeStudioId && !headers["X-Studio-Id"]) {
      headers["X-Studio-Id"] = activeStudioId;
    }
  }

  const controller = new AbortController();
  let abortReason: "caller" | "timeout" | null = null;
  const timeout = timeoutMs == null
    ? null
    : setTimeout(() => {
        abortReason ??= "timeout";
        controller.abort();
      }, timeoutMs);
  const abortFromCaller = () => {
    abortReason ??= "caller";
    controller.abort();
  };

  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (abortReason === "timeout") {
        throw new Error(timeoutMessage);
      }
      throw createAbortError();
    }
    throw new Error(networkErrorMessage);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    signal?.removeEventListener("abort", abortFromCaller);
  }

  if (!res.ok) {
    throw new Error(await parseErrorResponse(res));
  }

  return parseSuccessResponse<T>(res);
}

async function apiFormFetch<T>(path: string, options: FormApiOptions): Promise<T> {
  const {
    token,
    body,
    method = "POST",
    headers: extraHeaders,
    omitStudioHeader = false,
    signal,
    timeoutMs = API_TIMEOUT_MS,
    timeoutMessage = "Request timed out. Please try again.",
    networkErrorMessage = "Failed to reach the backend. Please try again.",
  } = options;
  const headers: Record<string, string> = {
    ...extraHeaders,
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (typeof window !== "undefined" && !omitStudioHeader) {
    const activeStudioId = getActiveStudioIdCookie();
    if (activeStudioId && !headers["X-Studio-Id"]) {
      headers["X-Studio-Id"] = activeStudioId;
    }
  }

  const controller = new AbortController();
  let abortReason: "caller" | "timeout" | null = null;
  const timeout = timeoutMs == null
    ? null
    : setTimeout(() => {
        abortReason ??= "timeout";
        controller.abort();
      }, timeoutMs);
  const abortFromCaller = () => {
    abortReason ??= "caller";
    controller.abort();
  };

  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (abortReason === "timeout") {
        throw new Error(timeoutMessage);
      }
      throw createAbortError();
    }
    throw new Error(networkErrorMessage);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    signal?.removeEventListener("abort", abortFromCaller);
  }

  if (!res.ok) {
    throw new Error(await parseErrorResponse(res));
  }

  return parseSuccessResponse<T>(res);
}

export const api = {
  get: <T>(path: string, token?: string, options?: Omit<ApiOptions, "token" | "method" | "body">) =>
    apiFetch<T>(path, { ...options, token }),

  post: <T>(path: string, body: unknown, token?: string, options?: Omit<ApiOptions, "token" | "method" | "body">) =>
    apiFetch<T>(path, { ...options, method: "POST", body, token }),

  patch: <T>(path: string, body: unknown, token?: string, options?: Omit<ApiOptions, "token" | "method" | "body">) =>
    apiFetch<T>(path, { ...options, method: "PATCH", body, token }),

  delete: <T>(path: string, token?: string, options?: Omit<ApiOptions, "token" | "method" | "body">) =>
    apiFetch<T>(path, { ...options, method: "DELETE", token }),

  postForm: <T>(
    path: string,
    body: FormData,
    token?: string,
    options?: Omit<FormApiOptions, "token" | "method" | "body">
  ) =>
    apiFormFetch<T>(path, { ...options, method: "POST", body, token }),
};
