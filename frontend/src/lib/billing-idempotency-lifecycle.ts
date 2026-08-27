const NEW_IDEMPOTENCY_KEY_DETAIL = /\bnew Idempotency-Key\b/i;

export function isTerminalBillingIdempotencyError(error: unknown) {
  return (
    error instanceof Error
    && "status" in error
    && error.status === 409
    && NEW_IDEMPOTENCY_KEY_DETAIL.test(error.message)
  );
}

export function clearBillingIdempotencyKeyAfterTerminalError(
  error: unknown,
  clearRequestKey: () => void,
) {
  if (!isTerminalBillingIdempotencyError(error)) {
    return false;
  }
  clearRequestKey();
  return true;
}
