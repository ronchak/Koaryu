import type { AttendanceRecord, AttendanceStatus, ClassSession, ClassTemplate } from "@/types";

type ScheduleReadFreshness = {
  authCurrent: boolean;
  currentGeneration: number;
  currentDataRevision: number;
  currentRequestSequence: number;
  dataRevisionAtStart: number;
  generationAtStart: number;
  mutationsInFlight: number;
  requestSequenceAtStart: number;
};

export type ScheduleDateRange = {
  endDate: string;
  startDate: string;
};

export type ScheduleCoordinatorState = {
  attendanceRequestSequence: number;
  dataRevision: number;
  generation: number;
  hasAuthoritativeSnapshot: boolean;
  mutationCountsByGeneration: Record<number, number>;
  mutationsInFlight: number;
  requestedRange: ScheduleDateRange | null;
  rangeRequestSequence: number;
};

export function createScheduleCoordinatorState(): ScheduleCoordinatorState {
  return {
    attendanceRequestSequence: 0,
    dataRevision: 0,
    generation: 0,
    hasAuthoritativeSnapshot: false,
    mutationCountsByGeneration: {},
    mutationsInFlight: 0,
    requestedRange: null,
    rangeRequestSequence: 0,
  };
}

export function resetScheduleCoordinatorState(
  current: ScheduleCoordinatorState,
  hasAuthoritativeSnapshot = false
): ScheduleCoordinatorState {
  return {
    attendanceRequestSequence: current.attendanceRequestSequence + 1,
    dataRevision: current.dataRevision + 1,
    generation: current.generation + 1,
    hasAuthoritativeSnapshot,
    mutationCountsByGeneration: {},
    mutationsInFlight: 0,
    requestedRange: null,
    rangeRequestSequence: current.rangeRequestSequence + 1,
  };
}

export function refreshScheduleCoordinatorAuthState(
  current: ScheduleCoordinatorState
): ScheduleCoordinatorState {
  return {
    ...current,
    attendanceRequestSequence: current.attendanceRequestSequence + 1,
    dataRevision: current.dataRevision + 1,
    generation: current.generation + 1,
    hasAuthoritativeSnapshot: false,
    rangeRequestSequence: current.rangeRequestSequence + 1,
  };
}

export function setScheduleRequestedRangeState(
  current: ScheduleCoordinatorState,
  requestedRange: ScheduleDateRange
): ScheduleCoordinatorState {
  return {
    ...current,
    requestedRange,
  };
}

export function resolveScheduleReconciliationRange(
  current: ScheduleCoordinatorState,
  fallback: ScheduleDateRange
): ScheduleDateRange {
  return current.requestedRange ?? fallback;
}

export function shouldPreserveScheduleMutationsOnAuthChange(
  event: string,
  currentUserId: string | null,
  nextUserId: string | null
) {
  return event === "TOKEN_REFRESHED"
    && currentUserId !== null
    && currentUserId === nextUserId;
}

export function beginScheduleMutationState(
  current: ScheduleCoordinatorState
): ScheduleCoordinatorState {
  const generationMutationCount = current.mutationCountsByGeneration[current.generation] ?? 0;
  return {
    ...current,
    dataRevision: current.dataRevision + 1,
    hasAuthoritativeSnapshot: false,
    mutationCountsByGeneration: {
      ...current.mutationCountsByGeneration,
      [current.generation]: generationMutationCount + 1,
    },
    mutationsInFlight: current.mutationsInFlight + 1,
  };
}

export function finishScheduleMutationState(
  current: ScheduleCoordinatorState,
  generationAtStart: number
): ScheduleCoordinatorState {
  const generationMutationCount = current.mutationCountsByGeneration[generationAtStart] ?? 0;
  if (generationMutationCount === 0) {
    return current;
  }
  const mutationCountsByGeneration = { ...current.mutationCountsByGeneration };
  if (generationMutationCount === 1) {
    delete mutationCountsByGeneration[generationAtStart];
  } else {
    mutationCountsByGeneration[generationAtStart] = generationMutationCount - 1;
  }
  return {
    ...current,
    dataRevision: current.dataRevision + 1,
    mutationCountsByGeneration,
    mutationsInFlight: Math.max(0, current.mutationsInFlight - 1),
  };
}

export function markScheduleCoordinatorSnapshotState(
  current: ScheduleCoordinatorState
): ScheduleCoordinatorState {
  return {
    ...current,
    dataRevision: current.dataRevision + 1,
    hasAuthoritativeSnapshot: true,
  };
}

export function shouldReconcileSchedule(current: ScheduleCoordinatorState) {
  return current.mutationsInFlight === 0 && !current.hasAuthoritativeSnapshot;
}

export function createScheduleReconciliationQueue() {
  let inFlight: Promise<void> | null = null;
  let replayRequested = false;
  let latestAttempt: (() => Promise<void>) | null = null;
  let latestShouldRun: (() => boolean) | null = null;

  return function requestScheduleReconciliation(
    attempt: () => Promise<void>,
    shouldRun: () => boolean
  ): Promise<void> {
    latestAttempt = attempt;
    latestShouldRun = shouldRun;

    if (inFlight) {
      replayRequested = true;
      return inFlight;
    }

    const run = async () => {
      while (true) {
        const replayAlreadyRequested = replayRequested;
        replayRequested = false;
        const currentAttempt = latestAttempt;
        const currentShouldRun = latestShouldRun;
        if (!currentAttempt || !currentShouldRun?.()) {
          return;
        }
        let attemptError: unknown;
        let attemptFailed = false;
        try {
          await currentAttempt();
        } catch (error) {
          attemptError = error;
          attemptFailed = true;
        }

        const shouldReplay = replayRequested || replayAlreadyRequested;
        if (shouldReplay && latestShouldRun?.()) {
          continue;
        }
        if (attemptFailed) {
          throw attemptError;
        }
        return;
      }
    };

    const runPromise = Promise.resolve().then(run);
    inFlight = runPromise;
    const clearInFlight = () => {
      if (inFlight === runPromise) {
        inFlight = null;
      }
    };
    void runPromise.then(clearInFlight, clearInFlight);
    return runPromise;
  };
}

export function isScheduleReadCurrent({
  authCurrent,
  currentGeneration,
  currentDataRevision,
  currentRequestSequence,
  dataRevisionAtStart,
  generationAtStart,
  mutationsInFlight,
  requestSequenceAtStart,
}: ScheduleReadFreshness) {
  return authCurrent
    && currentGeneration === generationAtStart
    && mutationsInFlight === 0
    && currentDataRevision === dataRevisionAtStart
    && currentRequestSequence === requestSequenceAtStart;
}

function parseCalendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function toCalendarDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function compareSessions(a: ClassSession, b: ClassSession) {
  const dateCompare = a.date.localeCompare(b.date);
  if (dateCompare !== 0) {
    return dateCompare;
  }
  return a.start_time.localeCompare(b.start_time);
}

export function mergeSessionsForRange(
  current: ClassSession[],
  fetched: ClassSession[],
  startDate: string,
  endDate: string
): ClassSession[] {
  return [
    ...current.filter((session) => session.date < startDate || session.date > endDate),
    ...fetched,
  ].sort(compareSessions);
}

export function mergeAttendanceForSessions(
  current: AttendanceRecord[],
  fetched: AttendanceRecord[],
  replacedSessionIds: string[]
): AttendanceRecord[] {
  const replaced = new Set(replacedSessionIds);
  return [
    ...current.filter((record) => !replaced.has(record.session_id)),
    ...fetched,
  ];
}

export function updateSessionAttendanceCount(
  sessionList: ClassSession[],
  sessionId: string,
  delta: number
): ClassSession[] {
  if (delta === 0) {
    return sessionList;
  }

  return sessionList.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          attendance_count: Math.max(0, session.attendance_count + delta),
        }
      : session
  );
}

export function toAttendanceCountDelta(
  previousStatus: AttendanceStatus | null,
  nextStatus: AttendanceStatus | null
) {
  const previousCount = previousStatus && previousStatus !== "absent" ? 1 : 0;
  const nextCount = nextStatus && nextStatus !== "absent" ? 1 : 0;
  return nextCount - previousCount;
}

export function normalizeAttendanceRecords(records: AttendanceRecord[]): AttendanceRecord[] {
  return records.map((record) => ({
    ...record,
    student_name: record.student_name || "",
  }));
}

export function getPreviewTemplateSessionDates(template: ClassTemplate): string[] {
  const start = parseCalendarDate(template.start_date);
  const end = template.end_date ? parseCalendarDate(template.end_date) : parseCalendarDate(template.start_date);
  if (!template.end_date) {
    end.setDate(end.getDate() + 84);
  }

  const dates: string[] = [];
  const current = new Date(start);
  while (current <= end) {
    if (current.getDay() === template.day_of_week) {
      dates.push(toCalendarDateKey(current));
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}
