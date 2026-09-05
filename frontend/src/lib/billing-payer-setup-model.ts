export type PayerAutopaySetupRequest = {
  body: { return_url: string };
  headers: { "Idempotency-Key": string };
};

export type PayerSyncRequest = {
  headers: { "Idempotency-Key": string };
};

export type PayerOperationIdentity = {
  userId: string;
  studioId: string;
};

export type PayerOperationKind = "payer.setup" | "payer.sync";

export type PayerSetupState = {
  autopay_status: "not_configured" | "pending" | "enabled" | "disabled";
  autopay_authorized_at?: string | null;
  autopay_terms_accepted_at?: string | null;
  stripe_payment_method_id?: string | null;
};

export type PayerOperationStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export type PayerSetupAttempt = {
  disposition: "active" | "terminal_cleanup_failed";
  replacementBaseline: string | null;
  requestKey: string;
  version: 1;
};

const PAYER_OPERATION_STORAGE_PREFIX = "koaryu.billing.payer-operation.v1";
const MAX_PAYER_OPERATION_IDENTITY_BYTES = 160;
const MAX_PAYER_OPERATION_REQUEST_KEY_BYTES = 255;

export function createPayerAutopaySetupRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `payer-setup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildPayerSyncRequest(requestKey: string): PayerSyncRequest {
  return { headers: { "Idempotency-Key": requestKey } };
}

function isBoundedStorageValue(value: string, maximumBytes: number) {
  return (
    value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
    && new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

export function buildPayerOperationStorageKey(
  identity: PayerOperationIdentity,
  payerId: string,
  operation: PayerOperationKind,
) {
  const parts = [identity.userId, identity.studioId, payerId];
  if (
    parts.some(
      (part) => !isBoundedStorageValue(part, MAX_PAYER_OPERATION_IDENTITY_BYTES),
    )
  ) {
    return null;
  }
  return [
    PAYER_OPERATION_STORAGE_PREFIX,
    operation,
    ...parts.map((part) => encodeURIComponent(part)),
  ].join(":");
}

function browserStorage(): PayerOperationStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function payerOperationMemoryKey(
  identity: PayerOperationIdentity | null,
  operation: PayerOperationKind,
  payerId: string,
) {
  return `${operation}\u0000${identity?.userId ?? ""}\u0000${identity?.studioId ?? ""}\u0000${payerId}`;
}

function payerSetupBaseline(payer: PayerSetupState) {
  return JSON.stringify([
    payer.autopay_status,
    payer.stripe_payment_method_id ?? null,
    payer.autopay_authorized_at ?? null,
    payer.autopay_terms_accepted_at ?? null,
  ]);
}

function parsePersistedPayerSetupAttempt(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const attempt = parsed as Record<string, unknown>;
    if (
      attempt.version !== 1
      || !validPayerOperationRequestKey(attempt.requestKey)
      || (attempt.disposition !== undefined && attempt.disposition !== "active" && attempt.disposition !== "terminal_cleanup_failed")
      || (attempt.replacementBaseline !== null && typeof attempt.replacementBaseline !== "string")
    ) return null;
    return {
      disposition: attempt.disposition === "terminal_cleanup_failed" ? "terminal_cleanup_failed" : "active",
      replacementBaseline: attempt.replacementBaseline as string | null,
      requestKey: attempt.requestKey as string,
      version: 1,
    } satisfies PayerSetupAttempt;
  } catch {
    return null;
  }
}

function validPayerOperationRequestKey(value: unknown): value is string {
  return typeof value === "string"
    && isBoundedStorageValue(value, MAX_PAYER_OPERATION_REQUEST_KEY_BYTES);
}

export function resolvePersistedPayerSetupRequestKey({
  createKey = createPayerAutopaySetupRequestKey,
  attemptsByPayer,
  identity,
  keysByPayer,
  payer,
  storage = browserStorage(),
}: {
  createKey?: () => string;
  attemptsByPayer: Map<string, PayerSetupAttempt>;
  identity: PayerOperationIdentity | null;
  keysByPayer: Map<string, string>;
  payer: PayerSetupState & { id: string };
  storage?: PayerOperationStorage;
}) {
  const memoryKey = payerOperationMemoryKey(identity, "payer.setup", payer.id);
  const storageKey = identity
    ? buildPayerOperationStorageKey(identity, payer.id, "payer.setup")
    : null;
  let storedValue: string | null = null;
  if (storage && storageKey) {
    try {
      storedValue = storage.getItem(storageKey);
    } catch {
      storedValue = null;
    }
  }
  const persistedAttempt = parsePersistedPayerSetupAttempt(storedValue);
  const activeAttempt = attemptsByPayer.get(memoryKey) ?? persistedAttempt;
  if (activeAttempt?.disposition === "terminal_cleanup_failed") {
    throw new Error("The expired payer setup state could not be cleared from this browser. Clear site data or use another browser before creating another setup link.");
  }
  const baseline = payerSetupBaseline(payer);
  const replacementEligible = isPayerSetupReplacementEligible(payer);
  if (
    activeAttempt
    && (!replacementEligible || activeAttempt.replacementBaseline === baseline)
  ) {
    attemptsByPayer.set(memoryKey, activeAttempt);
    keysByPayer.set(memoryKey, activeAttempt.requestKey);
    return activeAttempt.requestKey;
  }
  if (!replacementEligible) {
    return resolvePersistedPayerOperationRequestKey({
      createKey,
      identity,
      keysByPayer,
      operation: "payer.setup",
      payerId: payer.id,
      storage,
    });
  }
  const requestKey = createKey();
  if (!validPayerOperationRequestKey(requestKey)) {
    throw new Error("Payer operation request key is invalid.");
  }
  const nextAttempt: PayerSetupAttempt = {
    disposition: "active",
    replacementBaseline: baseline,
    requestKey,
    version: 1,
  };
  attemptsByPayer.set(memoryKey, nextAttempt);
  keysByPayer.set(memoryKey, requestKey);
  if (storage && storageKey) {
    const serialized = JSON.stringify(nextAttempt);
    try {
      storage.setItem(storageKey, serialized);
      const readback = parsePersistedPayerSetupAttempt(storage.getItem(storageKey));
      if (
        !readback
        || readback.requestKey !== requestKey
        || readback.replacementBaseline !== baseline
      ) return requestKey;
    } catch {
      return requestKey;
    }
  }
  return requestKey;
}

export function clearPersistedPayerSetupAttempt({
  attemptsByPayer,
  identity,
  keysByPayer,
  payerId,
  storage = browserStorage(),
}: {
  attemptsByPayer: Map<string, PayerSetupAttempt>;
  identity: PayerOperationIdentity | null;
  keysByPayer: Map<string, string>;
  payerId: string;
  storage?: PayerOperationStorage;
}) {
  const memoryKey = payerOperationMemoryKey(identity, "payer.setup", payerId);
  const storageKey = identity
    ? buildPayerOperationStorageKey(identity, payerId, "payer.setup")
    : null;
  if (!storageKey) {
    attemptsByPayer.delete(memoryKey);
    keysByPayer.delete(memoryKey);
    return true;
  }
  if (storage) {
    try {
      storage.removeItem(storageKey);
      if (storage.getItem(storageKey) === null) {
        attemptsByPayer.delete(memoryKey);
        keysByPayer.delete(memoryKey);
        return true;
      }
    } catch {
      // Preserve a fail-closed in-memory attempt below.
    }
  }
  const existing = attemptsByPayer.get(memoryKey)
    ?? (storage
      ? parsePersistedPayerSetupAttempt(safePayerOperationStorageRead(storage, storageKey))
      : null);
  if (existing) {
    attemptsByPayer.set(memoryKey, {
      ...existing,
      disposition: "terminal_cleanup_failed",
    });
    keysByPayer.set(memoryKey, existing.requestKey);
  }
  return false;
}

function safePayerOperationStorageRead(storage: PayerOperationStorage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function resolvePersistedPayerOperationRequestKey({
  createKey = createPayerAutopaySetupRequestKey,
  identity,
  keysByPayer,
  operation,
  payerId,
  startNewRequest = false,
  storage = browserStorage(),
}: {
  createKey?: () => string;
  identity: PayerOperationIdentity | null;
  keysByPayer: Map<string, string>;
  operation: PayerOperationKind;
  payerId: string;
  startNewRequest?: boolean;
  storage?: PayerOperationStorage;
}) {
  const memoryKey = payerOperationMemoryKey(identity, operation, payerId);
  const existing = keysByPayer.get(memoryKey);
  if (existing && !startNewRequest) {
    return existing;
  }
  const storageKey = identity
    ? buildPayerOperationStorageKey(identity, payerId, operation)
    : null;
  if (!startNewRequest && storage && storageKey) {
    try {
      const persisted = storage.getItem(storageKey);
      if (
        persisted
        && isBoundedStorageValue(persisted, MAX_PAYER_OPERATION_REQUEST_KEY_BYTES)
      ) {
        keysByPayer.set(memoryKey, persisted);
        return persisted;
      }
    } catch {
      // Browser storage may be blocked. The scoped in-memory key remains safe.
    }
  }
  const next = createKey();
  if (!isBoundedStorageValue(next, MAX_PAYER_OPERATION_REQUEST_KEY_BYTES)) {
    throw new Error("Payer operation request key is invalid.");
  }
  keysByPayer.set(memoryKey, next);
  if (storage && storageKey) {
    try {
      storage.setItem(storageKey, next);
    } catch {
      // Keep the in-memory key when persistence is unavailable.
    }
  }
  return next;
}

export function clearPersistedPayerOperationRequestKey({
  identity,
  keysByPayer,
  operation,
  payerId,
  storage = browserStorage(),
}: {
  identity: PayerOperationIdentity | null;
  keysByPayer: Map<string, string>;
  operation: PayerOperationKind;
  payerId: string;
  storage?: PayerOperationStorage;
}) {
  const memoryKey = payerOperationMemoryKey(identity, operation, payerId);
  keysByPayer.delete(memoryKey);
  const storageKey = identity
    ? buildPayerOperationStorageKey(identity, payerId, operation)
    : null;
  if (storage && storageKey) {
    try {
      storage.removeItem(storageKey);
    } catch {
      // The in-memory key is already cleared.
    }
  }
}

export function buildPayerAutopaySetupRequest(
  returnUrl: string,
  requestKey: string,
): PayerAutopaySetupRequest {
  return {
    body: { return_url: returnUrl },
    headers: { "Idempotency-Key": requestKey },
  };
}

export function isPayerSetupReplacementEligible(payer: PayerSetupState) {
  return payer.autopay_status === "enabled"
    || (payer.autopay_status === "disabled" && Boolean(payer.stripe_payment_method_id));
}

export function payerSetupActionLabel(payer: PayerSetupState) {
  return isPayerSetupReplacementEligible(payer)
    ? "Replace payment method"
    : "Payer setup link";
}

export function getPayerAutopaySetupReturnUrl(origin: string) {
  return new URL("/payer-setup-complete", origin).toString();
}

export async function copyPayerAutopaySetupLink(
  url: string,
  writeText: ((value: string) => Promise<void>) | undefined =
    typeof navigator !== "undefined" ? navigator.clipboard?.writeText.bind(navigator.clipboard) : undefined,
) {
  if (!writeText) {
    return false;
  }
  try {
    await writeText(url);
    return true;
  } catch {
    return false;
  }
}
