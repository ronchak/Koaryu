export type EnrollmentActivationIdentity = {
  userId: string;
  studioId: string;
};

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

const STORAGE_PREFIX = "koaryu.billing.enrollment-activation.v1";

function isBounded(value: string, maximumBytes: number) {
  return (
    value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
    && new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function memoryKey(identity: EnrollmentActivationIdentity | null, enrollmentId: string) {
  return `${identity?.userId ?? ""}\u0000${identity?.studioId ?? ""}\u0000${enrollmentId}`;
}

function storageKey(identity: EnrollmentActivationIdentity, enrollmentId: string) {
  const parts = [identity.userId, identity.studioId, enrollmentId];
  if (parts.some((part) => !isBounded(part, 160))) return null;
  return [STORAGE_PREFIX, ...parts.map(encodeURIComponent)].join(":");
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function createEnrollmentActivationRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `enrollment-activation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function resolveEnrollmentActivationRequestKey({
  createKey = createEnrollmentActivationRequestKey,
  enrollmentId,
  identity,
  keysByEnrollment,
  startNewRequest = false,
  storage = browserStorage(),
}: {
  createKey?: () => string;
  enrollmentId: string;
  identity: EnrollmentActivationIdentity | null;
  keysByEnrollment: Map<string, string>;
  startNewRequest?: boolean;
  storage?: StorageLike;
}) {
  const scopedMemoryKey = memoryKey(identity, enrollmentId);
  const existing = keysByEnrollment.get(scopedMemoryKey);
  if (existing && !startNewRequest) return existing;
  const persistedKey = identity ? storageKey(identity, enrollmentId) : null;
  if (!startNewRequest && storage && persistedKey) {
    try {
      const persisted = storage.getItem(persistedKey);
      if (persisted && isBounded(persisted, 255)) {
        keysByEnrollment.set(scopedMemoryKey, persisted);
        return persisted;
      }
    } catch {}
  }
  const requestKey = createKey();
  if (!isBounded(requestKey, 255)) {
    throw new Error("Enrollment activation request key is invalid.");
  }
  keysByEnrollment.set(scopedMemoryKey, requestKey);
  if (storage && persistedKey) {
    try {
      storage.setItem(persistedKey, requestKey);
    } catch {}
  }
  return requestKey;
}

export function clearEnrollmentActivationRequestKey({
  enrollmentId,
  identity,
  keysByEnrollment,
  storage = browserStorage(),
}: {
  enrollmentId: string;
  identity: EnrollmentActivationIdentity | null;
  keysByEnrollment: Map<string, string>;
  storage?: StorageLike;
}) {
  keysByEnrollment.delete(memoryKey(identity, enrollmentId));
  const persistedKey = identity ? storageKey(identity, enrollmentId) : null;
  if (storage && persistedKey) {
    try {
      storage.removeItem(persistedKey);
    } catch {}
  }
}

export function buildEnrollmentActivationRequest(requestKey: string) {
  if (!isBounded(requestKey, 255)) {
    throw new Error("Enrollment activation request key is invalid.");
  }
  return { headers: { "Idempotency-Key": requestKey } };
}
