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
