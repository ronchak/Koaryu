export type InvoiceRetryRequestKeyStore = Map<string, string>;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const INVOICE_RETRY_STORAGE_PREFIX = "koaryu:billing-invoice-retry";

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
  return status === null || status >= 500;
}
