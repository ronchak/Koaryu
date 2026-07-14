import type { AttendanceRecord, AttendanceStatus, ClassSession, ClassTemplate } from "@/types";
import { getLatestAttendanceRecord } from "./attendance-record-model.ts";

const ATTENDANCE_TOGGLE_CYCLE: AttendanceStatus[] = ["present", "late", "absent"];

export interface AttendanceToggleTransition {
  existing: AttendanceRecord | null;
  nextStatus: AttendanceStatus | null;
  previousStatus: AttendanceStatus | null;
}

export interface SessionAttendanceRefreshResult {
  committed: boolean;
  records: AttendanceRecord[];
}

interface RunOptimisticAttendanceToggleOptions {
  attendance: AttendanceRecord[];
  checkedInAt: string;
  commitAttendance: (
    update: (current: AttendanceRecord[]) => AttendanceRecord[]
  ) => void;
  commitSessionCountDelta: (delta: number) => void;
  isCurrent?: () => boolean;
  name: string;
  optimisticId: string;
  request: (nextStatus: AttendanceStatus | null) => Promise<AttendanceRecord | null>;
  sessionId: string;
  studentId: string;
  studioId?: string;
}

export function getAttendanceToggleTransition(
  attendance: AttendanceRecord[],
  sessionId: string,
  studentId: string
): AttendanceToggleTransition {
  const existing = getLatestAttendanceRecord(
    attendance.filter(
      (record) => record.session_id === sessionId && record.student_id === studentId
    )
  ) ?? null;
  const previousStatus = existing?.status ?? null;
  const currentIndex = existing ? ATTENDANCE_TOGGLE_CYCLE.indexOf(existing.status) : -1;
  const nextStatus = existing && currentIndex === ATTENDANCE_TOGGLE_CYCLE.length - 1
    ? null
    : ATTENDANCE_TOGGLE_CYCLE[(currentIndex + 1 + ATTENDANCE_TOGGLE_CYCLE.length) % ATTENDANCE_TOGGLE_CYCLE.length];

  return { existing, nextStatus, previousStatus };
}

export function shouldRetryScheduleReadAfterCoordinatorChange(
  authCurrent: boolean,
  generationCurrent: boolean
) {
  return !authCurrent || !generationCurrent;
}

function replaceStudentAttendance(
  current: AttendanceRecord[],
  sessionId: string,
  studentId: string,
  replacement: AttendanceRecord | null
) {
  const next = current.filter(
    (record) => !(record.session_id === sessionId && record.student_id === studentId)
  );
  if (replacement) {
    next.push(replacement);
  }
  return next;
}

function restoreStudentAttendance(
  current: AttendanceRecord[],
  sessionId: string,
  studentId: string,
  replacements: AttendanceRecord[]
) {
  return [
    ...current.filter(
      (record) => !(record.session_id === sessionId && record.student_id === studentId)
    ),
    ...replacements,
  ];
}

export async function runOptimisticAttendanceToggle({
  attendance,
  checkedInAt,
  commitAttendance,
  commitSessionCountDelta,
  isCurrent = () => true,
  name,
  optimisticId,
  request,
  sessionId,
  studentId,
  studioId = "",
}: RunOptimisticAttendanceToggleOptions) {
  const previousRecords = attendance.filter(
    (record) => record.session_id === sessionId && record.student_id === studentId
  );
  const transition = getAttendanceToggleTransition(attendance, sessionId, studentId);
  const { existing, nextStatus } = transition;
  const optimisticRecord = nextStatus
    ? existing
      ? { ...existing, status: nextStatus, checked_in_at: checkedInAt }
      : {
          id: optimisticId,
          studio_id: studioId,
          session_id: sessionId,
          student_id: studentId,
          status: nextStatus,
          checked_in_at: checkedInAt,
          is_cross_program: false,
          counts_toward_eligibility: true,
          student_name: name,
        }
    : null;
  const hadCountableAttendance = attendance.some(
    (record) =>
      record.session_id === sessionId
      && record.student_id === studentId
      && record.status !== "absent"
  );
  const countDelta = toAttendanceCountDelta(
    hadCountableAttendance ? "present" : null,
    nextStatus
  );

  commitAttendance((current) =>
    replaceStudentAttendance(current, sessionId, studentId, optimisticRecord)
  );
  commitSessionCountDelta(countDelta);

  try {
    const result = await request(nextStatus);
    if (!isCurrent()) {
      return transition;
    }

    if (result) {
      commitAttendance((current) =>
        replaceStudentAttendance(current, sessionId, studentId, {
          ...result,
          student_name: existing?.student_name || name,
        })
      );
    }
    return transition;
  } catch (error) {
    if (isCurrent()) {
      commitAttendance((current) =>
        restoreStudentAttendance(current, sessionId, studentId, previousRecords)
      );
      commitSessionCountDelta(-countDelta);
    }
    throw error;
  }
}

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

export function isScheduleRangeCommitCurrent(
  rangeCurrent: boolean,
  attendanceCurrent: boolean
) {
  return rangeCurrent && attendanceCurrent;
}

export async function runScheduleRangeRefreshWithRetry<T>(
  attempt: () => Promise<{ committed: boolean; value: T }>,
  maximumAttempts = 3,
  waitForStableCoordinator: () => Promise<void> = () => Promise.resolve()
): Promise<T> {
  for (let attemptNumber = 0; attemptNumber < maximumAttempts; attemptNumber += 1) {
    await waitForStableCoordinator();
    const result = await attempt();
    if (result.committed) {
      return result.value;
    }
  }
  throw new Error("Schedule range refresh was superseded. Please retry.");
}

export type ScheduleRangeRefreshIntent = "read" | "materialize";

export function buildScheduleRangeRequest(
  startDate: string,
  endDate: string,
  intent: ScheduleRangeRefreshIntent,
  canMaterialize: boolean
) {
  const rangeQuery = `start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;
  const shouldMaterialize = intent === "materialize" && canMaterialize;
  return {
    method: shouldMaterialize ? "POST" as const : "GET" as const,
    path: shouldMaterialize
      ? `/schedule/sessions/materialize?${rangeQuery}`
      : `/schedule/sessions?${rangeQuery}`,
  };
}

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

export type ScheduleReconciliationQueue = {
  (
    attempt: () => Promise<void>,
    shouldRun: () => boolean,
    intent?: ScheduleRangeRefreshIntent,
    isExecutionSafe?: () => boolean,
    generation?: number
  ): Promise<void>;
  invalidate: (minimumGeneration: number) => void;
};

export function createScheduleReconciliationQueue(): ScheduleReconciliationQueue {
  let inFlight: Promise<void> | null = null;
  let activeGeneration: number | null = null;
  let activeIntent: ScheduleRangeRefreshIntent | null = null;
  let minimumGeneration = 0;
  let pendingRequest: {
    attempt: () => Promise<void>;
    generation: number;
    isExecutionSafe: () => boolean;
    forceRun: boolean;
    intent: ScheduleRangeRefreshIntent;
    shouldRun: () => boolean;
  } | null = null;

  const enqueuePending = (request: NonNullable<typeof pendingRequest>) => {
    if (pendingRequest && request.generation !== pendingRequest.generation) {
      if (request.generation > pendingRequest.generation) {
        pendingRequest = request;
      }
      return;
    }
    if (!pendingRequest || request.intent === "materialize" || pendingRequest.intent === "read") {
      request.forceRun = request.forceRun || pendingRequest?.forceRun || false;
      pendingRequest = request;
    }
  };

  const deferActiveRequest = (request: NonNullable<typeof pendingRequest>) => {
    if (!pendingRequest) {
      pendingRequest = request;
      return;
    }
    if (request.generation !== pendingRequest.generation) {
      if (request.generation > pendingRequest.generation) {
        pendingRequest = request;
      }
      return;
    }
    pendingRequest.forceRun = pendingRequest.forceRun || request.forceRun;
    if (request.intent === "materialize" && pendingRequest.intent === "read") {
      request.forceRun = request.forceRun || pendingRequest.forceRun;
      pendingRequest = request;
    }
  };

  const requestScheduleReconciliation = function (
    attempt: () => Promise<void>,
    shouldRun: () => boolean,
    intent: ScheduleRangeRefreshIntent = "read",
    isExecutionSafe: () => boolean = () => true,
    generation = 0
  ): Promise<void> {
    if (generation < minimumGeneration) {
      return inFlight ?? Promise.resolve();
    }
    const request = {
      attempt,
      forceRun: false,
      generation,
      intent,
      isExecutionSafe,
      shouldRun,
    };

    if (inFlight) {
      if (activeGeneration !== null && generation < activeGeneration) {
        return inFlight;
      }
      // A read can satisfy the shared snapshot guard, but it cannot satisfy a
      // materialization request. Keep the higher-priority request and run it once.
      const forceRun = generation === activeGeneration
        && intent === "materialize"
        && activeIntent === "read";
      request.forceRun = forceRun;
      enqueuePending(request);
      return inFlight;
    }

    enqueuePending(request);
    const requestToRun = pendingRequest ?? request;
    pendingRequest = null;
    activeGeneration = requestToRun.generation;
    activeIntent = requestToRun.intent;
    const run = async () => {
      let currentRequest = requestToRun;
      while (currentRequest) {
        if (currentRequest.generation < minimumGeneration) {
          const nextRequest = pendingRequest;
          pendingRequest = null;
          if (nextRequest) {
            currentRequest = nextRequest;
            continue;
          }
          return;
        }
        activeGeneration = currentRequest.generation;
        activeIntent = currentRequest.intent;
        let attemptError: unknown;
        let attemptFailed = false;
        const shouldAttempt = currentRequest.forceRun || currentRequest.shouldRun();
        // Priority may override snapshot satisfaction, never mutation settlement.
        if (shouldAttempt && !currentRequest.isExecutionSafe()) {
          if (
            pendingRequest
            && pendingRequest.generation > currentRequest.generation
          ) {
            currentRequest = pendingRequest;
            pendingRequest = null;
            continue;
          }
          deferActiveRequest(currentRequest);
          return;
        }
        if (shouldAttempt) {
          try {
            await currentRequest.attempt();
          } catch (error) {
            attemptError = error;
            attemptFailed = true;
          }
        }

        if (currentRequest.generation < minimumGeneration) {
          const nextRequest = pendingRequest;
          pendingRequest = null;
          if (nextRequest) {
            currentRequest = nextRequest;
            continue;
          }
          return;
        }

        const nextRequest = pendingRequest;
        pendingRequest = null;
        if (nextRequest) {
          if (
            attemptFailed
            && currentRequest.intent === "materialize"
            && nextRequest.intent === "read"
            && currentRequest.generation === nextRequest.generation
          ) {
            throw attemptError;
          }
          currentRequest = nextRequest;
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
        activeGeneration = null;
        activeIntent = null;
      }
    };
    void runPromise.then(clearInFlight, clearInFlight);
    return runPromise;
  } as ScheduleReconciliationQueue;

  requestScheduleReconciliation.invalidate = (nextMinimumGeneration: number) => {
    minimumGeneration = Math.max(minimumGeneration, nextMinimumGeneration);
    if (pendingRequest && pendingRequest.generation < minimumGeneration) {
      pendingRequest = null;
    }
  };

  return requestScheduleReconciliation;
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

export function isAuthoritativeScheduleReady(current: ScheduleCoordinatorState) {
  return current.mutationsInFlight === 0 && current.hasAuthoritativeSnapshot;
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
