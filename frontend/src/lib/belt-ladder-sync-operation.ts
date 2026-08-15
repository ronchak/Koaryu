import type { BeltLadderSyncPayload } from "@/lib/belt-store-model";

export interface PendingBeltLadderSync {
  fingerprint: string;
  request: BeltLadderSyncPayload & { operation_id: string };
}

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function storageKey(studioId: string, ladderId: string): string {
  return `koaryu:pending-belt-sync:${studioId}:${ladderId}`;
}

function browserSessionStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadPendingBeltLadderSync(
  studioId: string,
  ladderId: string,
  storage: StorageLike | null = browserSessionStorage(),
): PendingBeltLadderSync | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey(studioId, ladderId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingBeltLadderSync>;
    if (
      typeof parsed.fingerprint !== "string"
      || !parsed.request
      || typeof parsed.request.operation_id !== "string"
      || typeof parsed.request.sub_rank_term !== "string"
      || !Array.isArray(parsed.request.ranks)
    ) {
      storage.removeItem(storageKey(studioId, ladderId));
      return null;
    }
    return parsed as PendingBeltLadderSync;
  } catch {
    try {
      storage.removeItem(storageKey(studioId, ladderId));
    } catch {
      // Best-effort browser recovery only.
    }
    return null;
  }
}

export function persistPendingBeltLadderSync(
  studioId: string,
  ladderId: string,
  pending: PendingBeltLadderSync,
  storage: StorageLike | null = browserSessionStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey(studioId, ladderId), JSON.stringify(pending));
  } catch {
    // The in-memory receipt still protects retries in this mount.
  }
}

export function clearPendingBeltLadderSync(
  studioId: string,
  ladderId: string,
  storage: StorageLike | null = browserSessionStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKey(studioId, ladderId));
  } catch {
    // Best-effort browser cleanup only.
  }
}

export function isTerminalBeltLadderSyncError(error: unknown): boolean {
  const status = error instanceof Error
    ? (error as Error & { status?: unknown }).status
    : undefined;
  return typeof status === "number"
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 429;
}
