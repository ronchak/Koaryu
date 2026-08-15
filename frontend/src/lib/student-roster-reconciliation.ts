export function isStudentRosterSnapshotCurrent({
  authCurrent,
  currentMutationEpoch,
  currentRequestSequence,
  mutationEpochAtStart,
  requestSequence,
}: {
  authCurrent: boolean;
  currentMutationEpoch: number;
  currentRequestSequence: number;
  mutationEpochAtStart: number;
  requestSequence: number;
}): boolean {
  return authCurrent
    && currentMutationEpoch === mutationEpochAtStart
    && currentRequestSequence === requestSequence;
}

/**
 * Whether a superseded roster refresh should be re-fetched rather than abandoned.
 *
 * Refusing to commit a stale snapshot is correct, but resolving anyway told
 * callers the reconciliation succeeded. Bulk status/tag changes, rank
 * transitions, and ladder saves then skipped their fallback paths, so a
 * concurrent unrelated edit could keep a committed mutation out of the local
 * roster indefinitely.
 *
 * A retry is only useful when this request is still the newest one: a newer
 * request will commit on its own, and racing it would just re-lose.
 */
export function shouldRetryStudentRosterRefresh({
  attempt,
  authCurrent,
  currentRequestSequence,
  maxAttempts,
  requestSequence,
}: {
  attempt: number;
  authCurrent: boolean;
  currentRequestSequence: number;
  maxAttempts: number;
  requestSequence: number;
}): boolean {
  return attempt < maxAttempts
    && authCurrent
    && currentRequestSequence === requestSequence;
}
