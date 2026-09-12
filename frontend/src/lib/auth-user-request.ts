type AuthFailure = { name?: string; status?: number };
type UserResult<T> = { data: { user: T | null }; error?: AuthFailure | null };

export class AuthProviderUnavailable extends Error {
  constructor() {
    super("Authentication is temporarily unavailable.");
  }
}

function transient(error: AuthFailure) {
  return (
    error.name === "AuthRetryableFetchError" ||
    error.status === 0 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  );
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}

/** Two reads at most within the caller's shared deadline, including SDK retries. */
export async function requestAuthUser<T>(
  read: () => Promise<UserResult<T>>,
  signal: AbortSignal,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal.throwIfAborted();
    try {
      const result = await abortable(Promise.resolve().then(read), signal);
      if (!result.error) return result.data.user;
      // The SDK error omits Retry-After; do not retry a rate limit prematurely.
      if (result.error.status === 429) throw new AuthProviderUnavailable();
      if (!transient(result.error)) {
        if (
          result.error.status === 400 ||
          result.error.status === 401 ||
          result.error.status === 403 ||
          result.error.name === "AuthSessionMissingError"
        )
          return null;
        throw new AuthProviderUnavailable();
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
    }
    if (attempt === 0) await abortable(new Promise((resolve) => setTimeout(resolve, 250)), signal);
  }
  throw new AuthProviderUnavailable();
}
