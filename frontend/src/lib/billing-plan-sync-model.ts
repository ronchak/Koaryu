export type PlanSyncIdentity = {
  userId: string;
  studioId: string;
};

type PlanSyncStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

const PLAN_SYNC_STORAGE_PREFIX = "koaryu.billing.plan-sync.v1";

function isBounded(value: string, maximumBytes: number) {
  return (
    value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
    && new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function storageKey(identity: PlanSyncIdentity, planId: string) {
  const parts = [identity.userId, identity.studioId, planId];
  if (parts.some((part) => !isBounded(part, 160))) {
    return null;
  }
  return [PLAN_SYNC_STORAGE_PREFIX, ...parts.map((part) => encodeURIComponent(part))].join(":");
}

function browserStorage(): PlanSyncStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function createPlanSyncRequestKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `plan-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function resolvePlanSyncRequestKey({
  createKey = createPlanSyncRequestKey,
  identity,
  keysByPlan,
  planId,
  startNewRequest = false,
  storage = browserStorage(),
}: {
  createKey?: () => string;
  identity: PlanSyncIdentity | null;
  keysByPlan: Map<string, string>;
  planId: string;
  startNewRequest?: boolean;
  storage?: PlanSyncStorage;
}) {
  const memoryKey = `${identity?.userId ?? ""}\u0000${identity?.studioId ?? ""}\u0000${planId}`;
  const existing = keysByPlan.get(memoryKey);
  if (existing && !startNewRequest) {
    return existing;
  }
  const persistedKey = identity ? storageKey(identity, planId) : null;
  if (!startNewRequest && storage && persistedKey) {
    try {
      const persisted = storage.getItem(persistedKey);
      if (persisted && isBounded(persisted, 255)) {
        keysByPlan.set(memoryKey, persisted);
        return persisted;
      }
    } catch {
      // Continue with the scoped memory key when browser storage is blocked.
    }
  }
  const next = createKey();
  if (!isBounded(next, 255)) {
    throw new Error("Plan sync request key is invalid.");
  }
  keysByPlan.set(memoryKey, next);
  if (storage && persistedKey) {
    try {
      storage.setItem(persistedKey, next);
    } catch {
      // The scoped memory key remains available for this page lifetime.
    }
  }
  return next;
}

export function clearPlanSyncRequestKey({
  identity,
  keysByPlan,
  planId,
  storage = browserStorage(),
}: {
  identity: PlanSyncIdentity | null;
  keysByPlan: Map<string, string>;
  planId: string;
  storage?: PlanSyncStorage;
}) {
  const memoryKey = `${identity?.userId ?? ""}\u0000${identity?.studioId ?? ""}\u0000${planId}`;
  keysByPlan.delete(memoryKey);
  const persistedKey = identity ? storageKey(identity, planId) : null;
  if (storage && persistedKey) {
    try {
      storage.removeItem(persistedKey);
    } catch {
      // The memory key is already cleared.
    }
  }
}

export function buildPlanSyncRequest(requestKey: string) {
  return { headers: { "Idempotency-Key": requestKey } };
}
