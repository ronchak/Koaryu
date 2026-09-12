import {
  CSV_IMPORT_PROXY_REQUEST_MAX_BYTES,
  DEFAULT_PROXY_REQUEST_MAX_BYTES,
  STUDENT_PHOTO_PROXY_REQUEST_MAX_BYTES,
} from "./request-body-limits.ts";
import { PROXY_BODY_TIMEOUT_MS } from "./request-budget.ts";

export class ProxyRequestBodyTimeoutError extends Error {
  constructor() {
    super("Request upload timed out.");
    this.name = "ProxyRequestBodyTimeoutError";
  }
}

export class ProxyRequestBodyTooLargeError extends Error {
  constructor() {
    super("Proxy request body is too large.");
    this.name = "ProxyRequestBodyTooLargeError";
  }
}

export class InvalidProxyContentLengthError extends Error {
  constructor() {
    super("Invalid Content-Length header.");
    this.name = "InvalidProxyContentLengthError";
  }
}

export function getProxyRequestBodyError(error: unknown) {
  if (error instanceof ProxyRequestBodyTimeoutError)
    return { status: 408, detail: error.message } as const;
  if (error instanceof ProxyRequestBodyTooLargeError) {
    return { status: 413, detail: "Request body is too large." } as const;
  }
  if (error instanceof InvalidProxyContentLengthError) {
    return { status: 400, detail: "Invalid Content-Length header." } as const;
  }
  return null;
}

const CSV_IMPORT_ACTIONS = new Set(["parse", "validate", "execute"]);

export function getProxyRequestBodyLimit(path: string[]) {
  if (
    path.length === 3 &&
    path[0] === "students" &&
    path[1] === "import" &&
    CSV_IMPORT_ACTIONS.has(path[2])
  ) {
    return CSV_IMPORT_PROXY_REQUEST_MAX_BYTES;
  }

  if (path.length === 3 && path[0] === "students" && path[1].length > 0 && path[2] === "photo") {
    return STUDENT_PHOTO_PROXY_REQUEST_MAX_BYTES;
  }

  return DEFAULT_PROXY_REQUEST_MAX_BYTES;
}

function rejectOversizedDeclaredBody(headers: Headers, maxBytes: number) {
  const contentLength = headers.get("content-length");
  if (contentLength === null) {
    return;
  }
  if (!/^\d+$/.test(contentLength)) {
    throw new InvalidProxyContentLengthError();
  }

  if (BigInt(contentLength) > BigInt(maxBytes)) {
    throw new ProxyRequestBodyTooLargeError();
  }
}

export async function readBoundedProxyRequestBody(
  request: Pick<Request, "body" | "headers"> & Partial<Pick<Request, "signal">>,
  maxBytes: number,
  timeoutMs = PROXY_BODY_TIMEOUT_MS,
) {
  rejectOversizedDeclaredBody(request.headers, maxBytes);

  if (!request.body) {
    return new ArrayBuffer(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let expired = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  const timeout = setTimeout(() => {
    expired = true;
    cancel();
  }, timeoutMs);
  request.signal?.addEventListener("abort", cancel, { once: true });

  try {
    if (request.signal?.aborted) cancel();
    request.signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      request.signal?.throwIfAborted();
      if (expired) throw new ProxyRequestBodyTimeoutError();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        cancel();
        throw new ProxyRequestBodyTooLargeError();
      }
      chunks.push(value);
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body.buffer;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
