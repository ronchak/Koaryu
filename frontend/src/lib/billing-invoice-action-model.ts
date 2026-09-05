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

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
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

export function buildInvoiceOperationRequest(requestKey: string) {
  if (!isBounded(requestKey, 255)) {
    throw new Error("Invoice operation request key is invalid.");
  }
  return { headers: { "Idempotency-Key": requestKey } };
}
