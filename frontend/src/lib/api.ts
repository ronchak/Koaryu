const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api/v1";

interface ApiOptions {
  token?: string;
  body?: unknown;
  method?: string;
}

interface FormApiOptions {
  token?: string;
  method?: string;
  body: FormData;
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

async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { token, body, method = "GET" } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(error.detail || `API error: ${res.status}`);
  }

  return parseSuccessResponse<T>(res);
}

async function apiFormFetch<T>(path: string, options: FormApiOptions): Promise<T> {
  const { token, body, method = "POST" } = options;
  const headers: Record<string, string> = {};

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(error.detail || `API error: ${res.status}`);
  }

  return parseSuccessResponse<T>(res);
}

export const api = {
  get: <T>(path: string, token?: string) =>
    apiFetch<T>(path, { token }),

  post: <T>(path: string, body: unknown, token?: string) =>
    apiFetch<T>(path, { method: "POST", body, token }),

  patch: <T>(path: string, body: unknown, token?: string) =>
    apiFetch<T>(path, { method: "PATCH", body, token }),

  delete: <T>(path: string, token?: string) =>
    apiFetch<T>(path, { method: "DELETE", token }),

  postForm: <T>(path: string, body: FormData, token?: string) =>
    apiFormFetch<T>(path, { method: "POST", body, token }),
};
