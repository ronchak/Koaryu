import { parseAuthProfileResponse } from "./store-bootstrap-model.ts";

const ATTEMPT_TIMEOUT_MS = 4_000;
const RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 1_000;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export class AuthProfileRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`/auth/me returned ${status}`);
    this.status = status;
  }
}

function retryDelay(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) return RETRY_DELAY_MS;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay)) return RETRY_DELAY_MS;
  // Do not retry earlier than the provider permits or hold navigation for a
  // long outage. The caller will use the existing unavailable page instead.
  return delay > MAX_RETRY_DELAY_MS ? null : Math.max(RETRY_DELAY_MS, delay);
}

export async function requestAuthProfile(
  apiBaseUrl: string,
  accessToken: string,
  signal: AbortSignal,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    const attemptSignal = AbortSignal.any([signal, timeout]);
    let delay: number | null = RETRY_DELAY_MS;
    try {
      const response = await fetch(`${apiBaseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
        signal: attemptSignal,
      });
      if (response.ok) {
        return parseAuthProfileResponse(await response.json());
      }
      delay = RETRYABLE_STATUSES.has(response.status) ? retryDelay(response) : null;
      void response.body?.cancel().catch(() => {});
      throw new AuthProfileRequestError(response.status);
    } catch (error) {
      signal.throwIfAborted();
      const retryable =
        error instanceof AuthProfileRequestError
          ? RETRYABLE_STATUSES.has(error.status)
          : error instanceof TypeError || timeout.aborted;
      if (attempt === 1 || !retryable || delay === null) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
  throw new Error("Auth profile attempts exhausted");
}
