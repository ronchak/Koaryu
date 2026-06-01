import { getActiveStudioIdCookie } from "@/lib/studio-state-cookie";
import { serializeJsonRequestBody } from "@/lib/api-body";
import { applyBrowserStudioHeader } from "@/lib/api-studio-header";

const SERVER_API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8001/api/v1";
const USE_API_PROXY = process.env.NEXT_PUBLIC_USE_API_PROXY === "true";
const BROWSER_API_BASE =
  USE_API_PROXY ? "/api/proxy" : SERVER_API_BASE;
const API_BASE = typeof window === "undefined" ? SERVER_API_BASE : BROWSER_API_BASE;
const API_TIMEOUT_MS = 12000;

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isSubscriptionRequiredError(error: unknown) {
  return error instanceof ApiError && error.status === 402;
}

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

  let headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (typeof window !== "undefined") {
    const activeStudioId = getActiveStudioIdCookie();
    headers = applyBrowserStudioHeader(headers, activeStudioId, {
      omitStudioHeader,
      useApiProxy: USE_API_PROXY,
    });
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
      body: serializeJsonRequestBody(body),
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
    throw new ApiError(await parseErrorResponse(res), res.status);
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
  let headers: Record<string, string> = {
    ...extraHeaders,
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (typeof window !== "undefined") {
    const activeStudioId = getActiveStudioIdCookie();
    headers = applyBrowserStudioHeader(headers, activeStudioId, {
      omitStudioHeader,
      useApiProxy: USE_API_PROXY,
    });
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
    throw new ApiError(await parseErrorResponse(res), res.status);
  }

  return parseSuccessResponse<T>(res);
}

async function apiDownload(path: string, options: ApiOptions = {}): Promise<{ blob: Blob; filename: string | null }> {
  const {
    token,
    headers: extraHeaders,
    omitStudioHeader = false,
    signal,
    timeoutMs = API_TIMEOUT_MS,
    timeoutMessage = "Download timed out. Please try again.",
    networkErrorMessage = "Failed to reach the backend. Please try again.",
  } = options;
  let headers: Record<string, string> = {
    Accept: "text/csv",
    ...extraHeaders,
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (typeof window !== "undefined") {
    const activeStudioId = getActiveStudioIdCookie();
    headers = applyBrowserStudioHeader(headers, activeStudioId, {
      omitStudioHeader,
      useApiProxy: USE_API_PROXY,
    });
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
      method: "GET",
      headers,
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
    throw new ApiError(await parseErrorResponse(res), res.status);
  }

  const contentDisposition = res.headers.get("content-disposition") || "";
  const filenameMatch = /filename="?([^"]+)"?/i.exec(contentDisposition);
  return {
    blob: await res.blob(),
    filename: filenameMatch?.[1] ?? null,
  };
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

  download: (path: string, token?: string, options?: Omit<ApiOptions, "token" | "method" | "body">) =>
    apiDownload(path, { ...options, token }),
};
