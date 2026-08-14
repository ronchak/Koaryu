export type RankTransitionKind = "promotion" | "demotion";

export interface PendingRankTransition {
  fingerprint: string;
  operationId: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function storageKey(kind: RankTransitionKind, studentId: string): string {
  return `koaryu:pending-rank-transition:${kind}:${studentId}`;
}

function browserSessionStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function rankTransitionFingerprint(input: {
  student_id: string;
  to_rank_id: string;
  student_program_membership_id?: string | null;
  program_id?: string | null;
  notes?: string | null;
  reason?: string | null;
}): string {
  return JSON.stringify({
    student_id: input.student_id,
    to_rank_id: input.to_rank_id,
    student_program_membership_id: input.student_program_membership_id ?? null,
    program_id: input.program_id ?? null,
    notes: input.notes ?? null,
    reason: input.reason ?? null,
  });
}

export function loadPendingRankTransition(
  kind: RankTransitionKind,
  studentId: string,
  storage: StorageLike | null = browserSessionStorage(),
): PendingRankTransition | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey(kind, studentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingRankTransition>;
    if (
      typeof parsed.fingerprint !== "string"
      || typeof parsed.operationId !== "string"
    ) {
      storage.removeItem(storageKey(kind, studentId));
      return null;
    }
    return parsed as PendingRankTransition;
  } catch {
    try {
      storage.removeItem(storageKey(kind, studentId));
    } catch {
      // Best-effort browser recovery only.
    }
    return null;
  }
}

export function persistPendingRankTransition(
  kind: RankTransitionKind,
  studentId: string,
  pending: PendingRankTransition,
  storage: StorageLike | null = browserSessionStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey(kind, studentId), JSON.stringify(pending));
  } catch {
    // The in-memory receipt still protects retries in this mount.
  }
}

export function clearPendingRankTransition(
  kind: RankTransitionKind,
  studentId: string,
  storage: StorageLike | null = browserSessionStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKey(kind, studentId));
  } catch {
    // Best-effort browser cleanup only.
  }
}

export function isTerminalRankTransitionError(error: unknown): boolean {
  const status = error instanceof Error
    ? (error as Error & { status?: unknown }).status
    : undefined;
  return typeof status === "number"
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 429;
}
