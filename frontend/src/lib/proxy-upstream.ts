// Covers headers and the streamed response body. Bulk operations may wait up to
// 120 seconds at the backend, so leave room for admission and response transfer.
const UPSTREAM_TIMEOUT_MS = 150_000;

export class ProxyUpstreamTimeoutError extends Error {
  constructor() {
    super("Backend API response timed out.");
    this.name = "ProxyUpstreamTimeoutError";
  }
}

export async function fetchProxyUpstream(
  url: URL,
  init: RequestInit,
  callerSignal: AbortSignal,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let ended = false;
  const cleanup = () => {
    clearTimeout(timer);
    callerSignal.removeEventListener("abort", cancelFromCaller);
  };
  const abort = (reason: Error) => {
    if (ended) return;
    ended = true;
    controller.abort(reason);
    downstream?.error(reason);
    void reader?.cancel(reason).catch(() => undefined);
    cleanup();
  };
  const cancelFromCaller = () => abort(new DOMException("Request was canceled.", "AbortError"));
  const timer = setTimeout(() => abort(new ProxyUpstreamTimeoutError()), timeoutMs);
  // An unconsumed response must retain its deadline without keeping Node alive.
  timer.unref?.();
  callerSignal.addEventListener("abort", cancelFromCaller, { once: true });
  if (callerSignal.aborted) cancelFromCaller();

  try {
    const upstream = await fetch(url, { ...init, signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!upstream.body) {
      ended = true;
      cleanup();
      return upstream;
    }
    const upstreamReader = upstream.body.getReader();
    reader = upstreamReader;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        downstream = streamController;
      },
      async pull(streamController) {
        try {
          const result = await upstreamReader.read();
          if (ended) return;
          if (result.done) {
            ended = true;
            cleanup();
            streamController.close();
          } else {
            streamController.enqueue(result.value);
          }
        } catch (error) {
          if (ended) return;
          ended = true;
          cleanup();
          streamController.error(error);
        }
      },
      cancel() {
        // Consumer cancellation also releases the upstream socket.
        downstream = undefined;
        abort(new DOMException("Response consumption was canceled.", "AbortError"));
      },
    });
    return new Response(body, { status: upstream.status, headers: upstream.headers });
  } catch (error) {
    cleanup();
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  }
}
