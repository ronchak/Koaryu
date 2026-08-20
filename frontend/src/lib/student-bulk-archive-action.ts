type Ref<T> = { current: T };

type LiveRequest = { token: string; isCurrent: () => boolean };

type CommitStudents<T> = (
  next: T[] | ((current: T[]) => T[]),
  options?: { mayBePartial?: boolean },
) => void;

type SnapshotCurrent = (input: {
  authCurrent: boolean;
  currentMutationEpoch: number;
  currentRequestSequence: number;
  mutationEpochAtStart: number;
  requestSequence: number;
}) => boolean;

export interface StudentBulkArchiveActionOptions<T extends { id: string }> {
  beginLiveAuthRequest: () => LiveRequest;
  commitStudents: CommitStudents<T>;
  fetchAllStudents: (token: string, options: { timeoutMs: number }) => Promise<T[]>;
  ids: string[];
  isPreviewMode: boolean;
  isStudentRosterSnapshotCurrent: SnapshotCurrent;
  normalizeStudentIds: (ids: string[]) => string[];
  onStudentMutation: () => void;
  persistStudents: (next: T[]) => void;
  postArchive: (token: string, studentIds: string[]) => Promise<unknown>;
  previewStudentPhotoUrlsRef: Ref<Record<string, string>>;
  revokeObjectURL: (url: string) => void;
  studentMutationEpochRef: Ref<number>;
  studentRosterRequestSequenceRef: Ref<number>;
  studentsMayBePartial: boolean;
  studentsRef: Ref<T[]>;
}

export async function deleteStudentsAction<T extends { id: string }>(
  options: StudentBulkArchiveActionOptions<T>,
): Promise<void> {
  const normalizedIds = options.normalizeStudentIds(options.ids);
  if (normalizedIds.length === 0) return;

  if (options.isPreviewMode) {
    const idSet = new Set(normalizedIds);
    normalizedIds.forEach((studentId) => {
      const photoUrl = options.previewStudentPhotoUrlsRef.current[studentId];
      if (photoUrl) {
        options.revokeObjectURL(photoUrl);
        delete options.previewStudentPhotoUrlsRef.current[studentId];
      }
    });
    options.persistStudents(options.studentsRef.current.filter((student) => !idSet.has(student.id)));
    options.onStudentMutation();
    return;
  }

  options.studentMutationEpochRef.current += 1;
  const liveRequest = options.beginLiveAuthRequest();
  try {
    await options.postArchive(liveRequest.token, normalizedIds);
  } catch (error) {
    if (liveRequest.isCurrent()) {
      options.onStudentMutation();
      try {
        const mutationEpoch = options.studentMutationEpochRef.current;
        const requestSequence = options.studentRosterRequestSequenceRef.current + 1;
        options.studentRosterRequestSequenceRef.current = requestSequence;
        const nextStudents = await options.fetchAllStudents(liveRequest.token, { timeoutMs: 30000 });
        if (options.isStudentRosterSnapshotCurrent({
          authCurrent: liveRequest.isCurrent(),
          currentMutationEpoch: options.studentMutationEpochRef.current,
          currentRequestSequence: options.studentRosterRequestSequenceRef.current,
          mutationEpochAtStart: mutationEpoch,
          requestSequence,
        })) {
          options.commitStudents(nextStudents);
        }
      } catch (refreshError) {
        console.error("Failed to refresh students after delete error", refreshError);
      }
    }
    throw error;
  }

  if (!liveRequest.isCurrent()) return;
  const idSet = new Set(normalizedIds);
  options.commitStudents(
    (current) => current.filter((student) => !idSet.has(student.id)),
    { mayBePartial: options.studentsMayBePartial },
  );
  options.onStudentMutation();
}
