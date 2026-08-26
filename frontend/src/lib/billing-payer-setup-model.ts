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

type PayerOperationStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

const PAYER_OPERATION_STORAGE_PREFIX = "koaryu.billing.payer-operation.v1";
const MAX_PAYER_OPERATION_IDENTITY_BYTES = 160;
const MAX_PAYER_OPERATION_REQUEST_KEY_BYTES = 255;

export function createPayerAutopaySetupRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `payer-setup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function resolvePayerAutopaySetupRequestKey(
  keysByPayer: Map<string, string>,
  payerId: string,
  startNewRequest = false,
  createKey: () => string = createPayerAutopaySetupRequestKey,
) {
  const existing = keysByPayer.get(payerId);
  if (existing && !startNewRequest) {
    return existing;
  }
  const next = createKey();
  keysByPayer.set(payerId, next);
  return next;
}

export function resolvePayerSyncRequestKey(
  keysByPayer: Map<string, string>,
  payerId: string,
  startNewRequest = false,
  createKey: () => string = createPayerAutopaySetupRequestKey,
) {
  return resolvePayerAutopaySetupRequestKey(
    keysByPayer,
    payerId,
    startNewRequest,
    createKey,
  );
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
  const memoryKey = `${operation}\u0000${identity?.userId ?? ""}\u0000${identity?.studioId ?? ""}\u0000${payerId}`;
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
  const memoryKey = `${operation}\u0000${identity?.userId ?? ""}\u0000${identity?.studioId ?? ""}\u0000${payerId}`;
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
