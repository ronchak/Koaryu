export type EnrollmentTransitionIdentity = {
  userId: string;
  studioId: string;
};

export type EnrollmentTransitionAction = "schedule-period-end" | "revoke-scheduled" | "cancel-immediate";

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

const STORAGE_PREFIX = "koaryu.billing.enrollment-transition.v1";

function bounded(value: string, maximumBytes: number) {
  return value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
    && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function storageKey(
  identity: EnrollmentTransitionIdentity,
  action: EnrollmentTransitionAction,
  resourceId: string,
) {
  const parts = [identity.userId, identity.studioId, action, resourceId];
  if (parts.some((part) => !bounded(part, 160))) return null;
  return [STORAGE_PREFIX, ...parts.map(encodeURIComponent)].join(":");
}

function memoryKey(
  identity: EnrollmentTransitionIdentity | null,
  action: EnrollmentTransitionAction,
  resourceId: string,
) {
  return `${identity?.userId ?? ""}\u0000${identity?.studioId ?? ""}\u0000${action}\u0000${resourceId}`;
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function createEnrollmentTransitionRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `enrollment-transition-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function resolveEnrollmentTransitionRequestKey({
  action,
  createKey = createEnrollmentTransitionRequestKey,
  identity,
  keys,
  resourceId,
  startNewRequest = false,
  storage = browserStorage(),
}: {
  action: EnrollmentTransitionAction;
  createKey?: () => string;
  identity: EnrollmentTransitionIdentity | null;
  keys: Map<string, string>;
  resourceId: string;
  startNewRequest?: boolean;
  storage?: StorageLike;
}) {
  const scopedMemoryKey = memoryKey(identity, action, resourceId);
  const existing = keys.get(scopedMemoryKey);
  if (existing && !startNewRequest) return existing;
  const persistedKey = identity ? storageKey(identity, action, resourceId) : null;
  if (!startNewRequest && storage && persistedKey) {
    try {
      const persisted = storage.getItem(persistedKey);
      if (persisted && bounded(persisted, 255)) {
        keys.set(scopedMemoryKey, persisted);
        return persisted;
      }
    } catch {}
  }
  const requestKey = createKey();
  if (!bounded(requestKey, 255)) throw new Error("Enrollment transition request key is invalid.");
  keys.set(scopedMemoryKey, requestKey);
  if (storage && persistedKey) {
    try {
      storage.setItem(persistedKey, requestKey);
    } catch {}
  }
  return requestKey;
}

export function clearEnrollmentTransitionRequestKey({
  action,
  identity,
  keys,
  resourceId,
  storage = browserStorage(),
}: {
  action: EnrollmentTransitionAction;
  identity: EnrollmentTransitionIdentity | null;
  keys: Map<string, string>;
  resourceId: string;
  storage?: StorageLike;
}) {
  keys.delete(memoryKey(identity, action, resourceId));
  const persistedKey = identity ? storageKey(identity, action, resourceId) : null;
  if (storage && persistedKey) {
    try {
      storage.removeItem(persistedKey);
    } catch {}
  }
}

export function enrollmentTransitionRequestOptions(requestKey: string) {
  if (!bounded(requestKey, 255)) throw new Error("Enrollment transition request key is invalid.");
  return { headers: { "Idempotency-Key": requestKey } };
}
