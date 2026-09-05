import type { StudentRosterCursorRecovery } from "@/lib/store-student-pages";

export const MAX_STUDENT_ROSTER_CURSOR_RECOVERY_ATTEMPTS = 4;

export interface StudentRosterCursorChainEntry {
  pageOrdinal: number;
  requestCursor: string | null;
  nextCursor: string | null;
  previousCursor: string | null;
}

export interface StudentRosterRecoveryTarget {
  pageOrdinal: number;
  cursor: string | null;
}

export function chooseStudentRosterRecoveryTarget({
  recoverTo,
  failedPageOrdinal,
  history,
  attemptedPageOrdinals,
  maxAttempts = MAX_STUDENT_ROSTER_CURSOR_RECOVERY_ATTEMPTS,
}: {
  recoverTo: StudentRosterCursorRecovery;
  failedPageOrdinal: number;
  history: ReadonlyMap<number, StudentRosterCursorChainEntry>;
  attemptedPageOrdinals: ReadonlySet<number>;
  maxAttempts?: number;
}): StudentRosterRecoveryTarget | null {
  if (attemptedPageOrdinals.size >= maxAttempts) {
    return null;
  }

  if (recoverTo === "first") {
    return attemptedPageOrdinals.has(1)
      ? null
      : { pageOrdinal: 1, cursor: null };
  }

  const priorPage = Array.from(history.values())
    .filter((entry) => (
      entry.pageOrdinal < failedPageOrdinal &&
      !attemptedPageOrdinals.has(entry.pageOrdinal)
    ))
    .sort((left, right) => right.pageOrdinal - left.pageOrdinal)[0];

  if (priorPage) {
    return {
      pageOrdinal: priorPage.pageOrdinal,
      cursor: priorPage.requestCursor,
    };
  }

  return attemptedPageOrdinals.has(1)
    ? null
    : { pageOrdinal: 1, cursor: null };
}

export function isStudentRosterRequestCurrent({
  requestSequence,
  activeRequestSequence,
  requestQueryKey,
  activeQueryKey,
  authCurrent,
}: {
  requestSequence: number;
  activeRequestSequence: number;
  requestQueryKey: string;
  activeQueryKey: string;
  authCurrent: boolean;
}) {
  return (
    authCurrent &&
    requestSequence === activeRequestSequence &&
    requestQueryKey === activeQueryKey
  );
}
