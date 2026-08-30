export type InvoiceRetryRequestKeyStore = Map<string, string>;

export type InvoiceOperationIdentity = {
  userId: string;
  studioId: string;
};

export type InvoiceOperationType =
  | "invoice.create"
  | "invoice.finalize"
  | "invoice.retry"
  | "invoice.void";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const INVOICE_RETRY_STORAGE_PREFIX = "koaryu:billing-invoice-retry";
const INVOICE_OPERATION_STORAGE_PREFIX = "koaryu.billing.invoice-operation.v1";

function isBounded(value: string, maximumBytes: number) {
  return (
    value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
    && new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function operationStorageKey(
  identity: InvoiceOperationIdentity,
  operation: InvoiceOperationType,
  targetId: string,
) {
  const parts = [identity.userId, identity.studioId, operation, targetId];
  if (parts.some((part) => !isBounded(part, 255))) return null;
  return [
    INVOICE_OPERATION_STORAGE_PREFIX,
    ...parts.map((part) => encodeURIComponent(part)),
  ].join(":");
}

function operationMemoryKey(
  identity: InvoiceOperationIdentity | null,
  operation: InvoiceOperationType,
  targetId: string,
) {
  return [identity?.userId ?? "", identity?.studioId ?? "", operation, targetId].join("\u0000");
}

export function getOrCreateInvoiceRetryRequestKey(
  keys: InvoiceRetryRequestKeyStore,
  invoiceId: string,
  createKey: () => string
) {
  const existing = keys.get(invoiceId);
  if (existing) return existing;
  const requestKey = createKey();
  keys.set(invoiceId, requestKey);
  return requestKey;
}

export function clearInvoiceRetryRequestKey(
  keys: InvoiceRetryRequestKeyStore,
  invoiceId: string
) {
  keys.delete(invoiceId);
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(storageScope: string) {
  return `${INVOICE_RETRY_STORAGE_PREFIX}:${storageScope}`;
}

function loadStoredKeys(storageScope: string, storage: StorageLike): Record<string, string> {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(storageScope)) || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0
      )
    );
  } catch {
    return {};
  }
}

export function getOrCreatePersistedInvoiceRetryRequestKey(
  storageScope: string,
  invoiceId: string,
  createKey: () => string,
  storage: StorageLike | null = browserStorage(),
  fallbackKeys?: InvoiceRetryRequestKeyStore
) {
  const fallbackKey = `${storageScope}:${invoiceId}`;
  const fallbackValue = fallbackKeys?.get(fallbackKey);
  if (fallbackValue) return fallbackValue;
  if (!storage) {
    const requestKey = createKey();
    fallbackKeys?.set(fallbackKey, requestKey);
    return requestKey;
  }
  const keys = loadStoredKeys(storageScope, storage);
  if (keys[invoiceId]) {
    fallbackKeys?.set(fallbackKey, keys[invoiceId]);
    return keys[invoiceId];
  }
  const requestKey = createKey();
  keys[invoiceId] = requestKey;
  fallbackKeys?.set(fallbackKey, requestKey);
  try {
    storage.setItem(storageKey(storageScope), JSON.stringify(keys));
  } catch {}
  return requestKey;
}

export function clearPersistedInvoiceRetryRequestKey(
  storageScope: string,
  invoiceId: string,
  storage: StorageLike | null = browserStorage(),
  fallbackKeys?: InvoiceRetryRequestKeyStore
) {
  fallbackKeys?.delete(`${storageScope}:${invoiceId}`);
  if (!storage) return;
  const keys = loadStoredKeys(storageScope, storage);
  delete keys[invoiceId];
  try {
    if (Object.keys(keys).length === 0) {
      storage.removeItem(storageKey(storageScope));
    } else {
      storage.setItem(storageKey(storageScope), JSON.stringify(keys));
    }
  } catch {}
}

export function shouldRetainInvoiceRetryRequestKey(status: number | null) {
  return status === null || status < 200 || status >= 300;
}

export function createInvoiceOperationRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `invoice-operation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function resolvePersistedInvoiceOperationRequestKey({
  createKey = createInvoiceOperationRequestKey,
  identity,
  keysByTarget,
  operation,
  startNewRequest = false,
  storage = browserStorage() ?? undefined,
  targetId,
}: {
  createKey?: () => string;
  identity: InvoiceOperationIdentity | null;
  keysByTarget: InvoiceRetryRequestKeyStore;
  operation: InvoiceOperationType;
  startNewRequest?: boolean;
  storage?: StorageLike;
  targetId: string;
}) {
  const memoryKey = operationMemoryKey(identity, operation, targetId);
  const existing = keysByTarget.get(memoryKey);
  if (existing && !startNewRequest) return existing;
  const persistedKey = identity
    ? operationStorageKey(identity, operation, targetId)
    : null;
  if (!startNewRequest && storage && persistedKey) {
    try {
      const persisted = storage.getItem(persistedKey);
      if (persisted && isBounded(persisted, 255)) {
        keysByTarget.set(memoryKey, persisted);
        return persisted;
      }
    } catch {
      // Continue with the exact scoped in-memory key.
    }
  }
  const requestKey = createKey();
  if (!isBounded(requestKey, 255)) {
    throw new Error("Invoice operation request key is invalid.");
  }
  keysByTarget.set(memoryKey, requestKey);
  if (storage && persistedKey) {
    try {
      storage.setItem(persistedKey, requestKey);
    } catch {
      // The exact scoped in-memory key remains available for this page lifetime.
    }
  }
  return requestKey;
}

export function clearPersistedInvoiceOperationRequestKey({
  identity,
  keysByTarget,
  operation,
  storage = browserStorage() ?? undefined,
  targetId,
}: {
  identity: InvoiceOperationIdentity | null;
  keysByTarget: InvoiceRetryRequestKeyStore;
  operation: InvoiceOperationType;
  storage?: StorageLike;
  targetId: string;
}) {
  keysByTarget.delete(operationMemoryKey(identity, operation, targetId));
  const persistedKey = identity
    ? operationStorageKey(identity, operation, targetId)
    : null;
  if (storage && persistedKey) {
    try {
      storage.removeItem(persistedKey);
    } catch {
      // The exact scoped in-memory key is already cleared.
    }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => (
      `${JSON.stringify(key)}:${stableJson(entryValue)}`
    )).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function invoiceDraftFingerprint(payload: unknown) {
  const bytes = new TextEncoder().encode(stableJson(payload));
  const fnv32 = (seed: number) => {
    let hash = seed;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  return `${fnv32(0x811c9dc5)}${fnv32(0x9e3779b9)}`;
}

export function buildInvoiceOperationRequest(requestKey: string) {
  if (!isBounded(requestKey, 255)) {
    throw new Error("Invoice operation request key is invalid.");
  }
  return { headers: { "Idempotency-Key": requestKey } };
}
