"use client";

import { useResumeRefresh } from "@/lib/use-resume-refresh";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { toLocalDateKey } from "@/lib/date";
import { useRetainedState } from "@/lib/retained-state";
import type { ClassFormInitialValues, ClassFormSubmitPayload } from "@/lib/class-form-model";
import {
  beginSessionAttendanceRefresh,
  clearSessionAttendanceRefresh,
  countUnmaterializedRecurringSlots,
  DEFAULT_SCHEDULE_PAGE_VIEW,
  getActiveScheduleStudents,
  createAttendanceToggleQueue,
  getScheduleLoadRange,
  getScheduleSessionAttendance,
  resolveScheduleLoadRange,
  isCompleteScheduleRoster,
  isSessionAttendanceReady,
  navigateScheduleDate,
  runSessionAttendanceRefresh,
  type SessionAttendanceRefreshState,
  type SchedulePageView,
} from "@/lib/schedule-page-model";
import {
  buildConsumedRouteHref,
  isSameScheduleTarget,
  resolveScheduleTargetSession,
  SCHEDULE_TARGET_PARAMS,
  type ScheduleRouteTarget,
} from "@/lib/route-targets";
import type { ScheduleTemplateCreateResult } from "@/lib/schedule-store-model";
import type { ScheduleSessionDeleteScope } from "@/lib/session-detail-model";
import type {
  ConfigStoreContextValue,
  ProgramsStoreContextValue,
  ScheduleStoreContextValue,
  StudentsStoreContextValue,
} from "@/lib/store-contexts";
import { hasStaffPermission } from "@/lib/staff-permissions";
import type { ClassSession } from "@/types";

type SchedulePageControllerOptions = {
  /** `studioTimezone` draws the calendar's now line; without it there is none. */
  config: Pick<ConfigStoreContextValue, "currentRole" | "businessDate"> &
    Partial<Pick<ConfigStoreContextValue, "studioTimezone">>;
  programsStore: Pick<ProgramsStoreContextValue, "programs" | "refreshPrograms">;
  scheduleStore: Pick<
    ScheduleStoreContextValue,
    | "addSession"
    | "addTemplate"
    | "attendance"
    | "deleteSession"
    | "refreshScheduleRange"
    | "refreshSessionAttendance"
    | "sessions"
    | "templates"
    | "toggleCheckIn"
  >;
  studentsStore: Pick<
    StudentsStoreContextValue,
    "refreshStudents" | "students" | "studentsLoaded" | "studentsMayBePartial"
  >;
  /** A `/schedule?date=…&session=…` link to open, parsed by the page. */
  routeTarget?: ScheduleRouteTarget | null;
};

type ScheduleRouteTargetNotice = { rangeKey: string; message: string };

function scheduleDateAtNoon(dateKey: string) {
  return new Date(`${dateKey}T12:00:00`);
}

/** The schedule never keeps a link's date or session in its address once used. */
function consumeScheduleTargetUrl() {
  const href = buildConsumedRouteHref(window.location, SCHEDULE_TARGET_PARAMS);
  if (href !== null) window.history.replaceState(null, "", href);
}

export function useSchedulePageController({
  config,
  programsStore,
  scheduleStore,
  studentsStore,
  routeTarget = null,
}: SchedulePageControllerOptions) {
  const canManageSchedule = hasStaffPermission(config.currentRole, "manage_schedule");
  const { refreshStudents, students, studentsLoaded, studentsMayBePartial } = studentsStore;
  const { programs, refreshPrograms } = programsStore;
  const {
    attendance,
    sessions,
    templates,
    addSession,
    addTemplate,
    deleteSession,
    refreshScheduleRange,
    refreshSessionAttendance,
    toggleCheckIn,
  } = scheduleStore;
  // A linked date opens as its day; without one the page starts on today's month.
  const [currentDate, setCurrentDate] = useState(() =>
    scheduleDateAtNoon(routeTarget?.date ?? config.businessDate),
  );
  const [view, setView] = useState<SchedulePageView>(
    routeTarget ? "day" : DEFAULT_SCHEDULE_PAGE_VIEW,
  );
  const [seenRouteTarget, setSeenRouteTarget] = useState(routeTarget);
  const [pendingRouteSession, setPendingRouteSession] = useState(
    routeTarget?.sessionId ? routeTarget : null,
  );
  const [routeTargetNotice, setRouteTargetNotice] = useState<ScheduleRouteTargetNotice | null>(
    null,
  );
  const [programFilter, setProgramFilter] = useState("");
  const [selectedSessionSnapshot, setSelectedSession] = useState<ClassSession | null>(null);
  const selectedSession = selectedSessionSnapshot
    ? (sessions.find((session) => session.id === selectedSessionSnapshot.id) ?? null)
    : null;
  const [classFormInitialValues, setClassFormInitialValues] = useState<ClassFormInitialValues>();
  const [showAddClass, setShowAddClass] = useState(false);
  const [isCreatingClass, setIsCreatingClass] = useState(false);
  const createClassInFlightRef = useRef(false);
  const createSequenceRef = useRef(0);
  const [createClassError, setCreateClassError] = useState<string | null>(null);
  const [rangeLoadAttempt, setRangeLoadAttempt] = useState(0);
  const [attendanceRefreshAttempt, setAttendanceRefreshAttempt] = useState(0);
  // The read of a window that has settled, as `${rangeKey}#${attempt}`; recurring
  // slots it left ungenerated are materialized once per such read.
  const [settledReadToken, setSettledReadToken] = useState<string | null>(null);
  const materializedTokenRef = useRef<string | null>(null);
  // The read and the materialization of one window overlap with navigation; the
  // window reads as refreshing while any request for it is in flight.
  const refreshCountsRef = useRef(new Map<string, number>());
  const [refreshingRangeKey, setRefreshingRangeKey] = useState<string | null>(null);
  const beginRangeRefresh = useCallback((key: string) => {
    const counts = refreshCountsRef.current;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    setRefreshingRangeKey(key);
  }, []);
  const endRangeRefresh = useCallback((key: string) => {
    const counts = refreshCountsRef.current;
    const remaining = (counts.get(key) ?? 1) - 1;
    if (remaining > 0) {
      counts.set(key, remaining);
      return;
    }
    counts.delete(key);
    setRefreshingRangeKey((current) => (current === key ? null : current));
  }, []);
  const [scheduleLoadError, setScheduleLoadError] = useState<string | null>(null);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);
  const [studentRosterLoadError, setStudentRosterLoadError] = useState<string | null>(null);
  const [isRefreshingStudentRoster, setIsRefreshingStudentRoster] = useState(false);
  const [pendingAttendanceIds, setPendingAttendanceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [attendanceToggleQueue] = useState(() =>
    createAttendanceToggleQueue(setPendingAttendanceIds),
  );
  const [sessionAttendanceRefresh, setSessionAttendanceRefresh] =
    useState<SessionAttendanceRefreshState>(clearSessionAttendanceRefresh);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState<ScheduleSessionDeleteScope | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  if (!isSameScheduleTarget(routeTarget, seenRouteTarget)) {
    // A new link while the page is open; clearing the address back to null changes nothing.
    setSeenRouteTarget(routeTarget);
    if (routeTarget) {
      setCurrentDate(scheduleDateAtNoon(routeTarget.date));
      setView("day");
      setPendingRouteSession(routeTarget.sessionId ? routeTarget : null);
      setRouteTargetNotice(null);
      // A session on the day already in view still waits for a fresh load of it.
      if (routeTarget.sessionId) setRangeLoadAttempt((value) => value + 1);
    }
  }

  // The page loads the month grid around its date and keeps that window while
  // the view stays inside it, so Day and Week steps and view switches there,
  // even across a month boundary, never wait on a request.
  const [storedLoadRange, setStoredLoadRange] = useState(() => getScheduleLoadRange(currentDate));
  const loadRange = resolveScheduleLoadRange(storedLoadRange, currentDate, view);
  if (loadRange !== storedLoadRange) setStoredLoadRange(loadRange);

  const loadRangeKey = `${loadRange.start}:${loadRange.end}`;
  const loadToken = `${loadRangeKey}#${rangeLoadAttempt}`;
  const [rangeReadiness, setRangeReadiness] = useRetainedState(`schedule:range:${loadRangeKey}`, {
    key: loadRangeKey,
    loaded: false,
  });
  const hasLoadedRange = rangeReadiness.key === loadRangeKey && rangeReadiness.loaded;
  const currentRangeKeyRef = useRef(loadRangeKey);

  // A linked session opens only after a successful load of a range holding its
  // date, through the same path as its "Take attendance" button. It settles once:
  // later refreshes, ranges and closing the modal never reopen it.
  const settleRouteSession = useEffectEvent(
    (rangeKey: string, start: string, end: string, loaded: ClassSession[]) => {
      const target = pendingRouteSession;
      if (!target) return;
      setPendingRouteSession(null);
      // The person moved on to other dates before the linked day loaded.
      if (target.date < start || target.date > end) return;
      const outcome = resolveScheduleTargetSession(
        target,
        Array.isArray(loaded) ? loaded : sessions,
      );
      if (outcome.kind === "open") {
        openSession(outcome.session);
        return;
      }
      setRouteTargetNotice({
        rangeKey,
        message:
          outcome.kind === "canceled"
            ? `${outcome.session.name} was canceled, so there is no attendance to take.`
            : "That class is no longer on this day's schedule.",
      });
    },
  );

  useEffect(() => {
    if (!seenRouteTarget || pendingRouteSession) return;
    consumeScheduleTargetUrl();
  }, [pendingRouteSession, seenRouteTarget]);

  useEffect(() => {
    currentRangeKeyRef.current = loadRangeKey;
  }, [loadRangeKey]);

  useResumeRefresh(() => {
    setRangeLoadAttempt((value) => value + 1);
    setAttendanceRefreshAttempt((value) => value + 1);
    void refreshPrograms({ includeArchived: true, includeUsage: false }).catch(() => undefined);
    if (selectedSession) {
      setIsRefreshingStudentRoster(true);
      setStudentRosterLoadError(null);
      void refreshStudents()
        .catch(() => setStudentRosterLoadError("Could not refresh the attendance roster."))
        .finally(() => setIsRefreshingStudentRoster(false));
    }
  });

  // A window paints from its read: one GET on the interactive lane. Recurring
  // classes it has not generated yet show as placeholders meanwhile.
  useEffect(() => {
    let cancelled = false;

    async function readRange() {
      setScheduleLoadError(null);
      beginRangeRefresh(loadRangeKey);
      try {
        const loaded = await refreshScheduleRange(loadRange.start, loadRange.end, "read");
        if (!cancelled) {
          setRangeReadiness((current) =>
            current.key === loadRangeKey ? { key: loadRangeKey, loaded: true } : current,
          );
          settleRouteSession(loadRangeKey, loadRange.start, loadRange.end, loaded);
          setSettledReadToken(loadToken);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load schedule range", error);
          setScheduleLoadError("Could not load this calendar range. Please try again.");
        }
      } finally {
        endRangeRefresh(loadRangeKey);
      }
    }

    void readRange();

    return () => {
      cancelled = true;
    };
  }, [
    beginRangeRefresh,
    endRangeRefresh,
    loadRange.end,
    loadRange.start,
    loadRangeKey,
    loadToken,
    refreshScheduleRange,
    setRangeReadiness,
  ]);

  // Only a window whose read left recurring slots ungenerated materializes them,
  // once per read, behind the painted calendar. Staff who cannot manage the
  // schedule read only; a later Retry or resume reads again and reconsiders.
  const hasUnmaterializedSlots = useMemo(
    () => countUnmaterializedRecurringSlots({ range: loadRange, sessions, templates }) > 0,
    [loadRange, sessions, templates],
  );
  const shouldMaterialize =
    settledReadToken === loadToken && canManageSchedule && hasUnmaterializedSlots;

  useEffect(() => {
    if (!shouldMaterialize || materializedTokenRef.current === loadToken) return;
    materializedTokenRef.current = loadToken;
    let cancelled = false;

    async function materializeRange() {
      beginRangeRefresh(loadRangeKey);
      try {
        await refreshScheduleRange(loadRange.start, loadRange.end, "materialize");
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to generate recurring classes for the schedule range", error);
        setScheduleLoadError(
          "Recurring classes for this range could not be generated. Retry to load them.",
        );
      } finally {
        endRangeRefresh(loadRangeKey);
      }
    }

    void materializeRange();

    return () => {
      cancelled = true;
    };
  }, [
    beginRangeRefresh,
    endRangeRefresh,
    loadRange.end,
    loadRange.start,
    loadRangeKey,
    loadToken,
    refreshScheduleRange,
    shouldMaterialize,
  ]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    let current = true;
    void runSessionAttendanceRefresh({
      isCurrent: () => current,
      onStateChange: setSessionAttendanceRefresh,
      refresh: () => refreshSessionAttendance(selectedSession.id),
      sessionId: selectedSession.id,
    }).catch((error) => {
      if (current) {
        console.error("Failed to load session attendance", error);
        setAttendanceError("Could not load attendance for this class. Please try again.");
      }
    });

    return () => {
      current = false;
    };
  }, [attendanceRefreshAttempt, refreshSessionAttendance, selectedSession]);

  const activeStudents = useMemo(
    () => getActiveScheduleStudents(students, config.businessDate),
    [config.businessDate, students],
  );
  const selectedSessionAttendance = useMemo(
    () => getScheduleSessionAttendance(attendance, selectedSession),
    [attendance, selectedSession],
  );

  function navigate(direction: number) {
    setCurrentDate((date) => navigateScheduleDate(date, view, direction));
  }

  function jumpToToday() {
    setCurrentDate(new Date(`${config.businessDate}T12:00:00`));
  }

  async function handleCreateClass(payload: ClassFormSubmitPayload) {
    if (!canManageSchedule || createClassInFlightRef.current) return;

    createClassInFlightRef.current = true;
    setCreateClassError(null);
    setIsCreatingClass(true);
    const rangeKey = loadRangeKey;
    let createdTemplate: ScheduleTemplateCreateResult | null = null;

    try {
      if (payload.kind === "single_session") {
        await addSession({
          name: payload.name,
          date: payload.sessionDate,
          start_time: payload.startTime,
          end_time: payload.endTime,
          program_id: payload.program_id,
          capacity: payload.capacity,
        });
      } else {
        createdTemplate = await addTemplate({
          name: payload.name,
          day_of_week: payload.recurrence.dayOfWeek,
          start_time: payload.startTime,
          end_time: payload.endTime,
          start_date: payload.recurrence.startDate,
          end_date: payload.recurrence.endDate,
          program_id: payload.program_id,
          capacity: payload.capacity,
        });
      }
    } catch (error) {
      console.error("Failed to create class", error);
      setCreateClassError(
        error instanceof Error ? error.message : "Could not create this class. Please try again.",
      );
      return;
    } finally {
      createClassInFlightRef.current = false;
      setIsCreatingClass(false);
    }

    // The create is confirmed. The store owns its follow-up refresh, and a failed
    // refresh must not reopen the confirmed create as retryable.
    setShowAddClass(false);
    if (!createdTemplate) {
      setActionMessage("Class added to the schedule.");
      return;
    }
    setActionMessage("Recurring class created.");
    const createSequence = (createSequenceRef.current += 1);
    const scheduleRefresh = await createdTemplate.scheduleRefresh;
    // A newer create owns the messages; after navigation the new range's load reports.
    if (createSequence !== createSequenceRef.current) return;
    if (scheduleRefresh === "refreshed") {
      setActionMessage("Recurring class created and visible sessions refreshed.");
    } else if (scheduleRefresh === "failed" && currentRangeKeyRef.current === rangeKey) {
      setScheduleLoadError(
        "Recurring class created, but its visible sessions could not refresh. Retry to load them.",
      );
    }
  }

  async function handleToggleAttendance(sessionId: string, studentId: string, name: string) {
    await attendanceToggleQueue.run(studentId, async () => {
      setAttendanceError(null);
      try {
        await toggleCheckIn(sessionId, studentId, name);
      } catch (error) {
        console.error("Failed to update attendance", error);
        setAttendanceError("Could not update attendance. Please try again.");
      }
    });
  }

  async function handleDeleteSelectedSession(scope: ScheduleSessionDeleteScope) {
    if (!canManageSchedule || !selectedSession) {
      return;
    }

    setDeleteError(null);
    setDeleteInFlight(scope);

    try {
      await deleteSession(selectedSession.id, scope === "series" ? "future_series" : "session");
      setSelectedSession(null);
      setActionMessage(
        scope === "series" ? "Recurring class series removed." : "Class removed from the schedule.",
      );
    } catch (error) {
      console.error("Failed to delete session", error);
      setDeleteError(
        error instanceof Error ? error.message : "Could not delete this class. Please try again.",
      );
    } finally {
      setDeleteInFlight(null);
    }
  }

  function openAddClass() {
    if (!canManageSchedule) return;
    setPendingRouteSession(null);
    const selectedDay = toLocalDateKey(currentDate);
    setClassFormInitialValues({ date: selectedDay, startDate: selectedDay });
    setCreateClassError(null);
    setShowAddClass(true);
  }

  function openSession(session: ClassSession) {
    setAttendanceError(null);
    setDeleteError(null);
    setStudentRosterLoadError(null);
    setSessionAttendanceRefresh(beginSessionAttendanceRefresh(session.id));
    setSelectedSession(session);
    if (!isCompleteScheduleRoster({ studentsLoaded, studentsMayBePartial })) {
      setIsRefreshingStudentRoster(true);
      void refreshStudents()
        .catch((error) => {
          console.error("Failed to load complete student roster", error);
          setStudentRosterLoadError("Could not load the complete roster for attendance.");
        })
        .finally(() => setIsRefreshingStudentRoster(false));
    }
  }

  // Choosing a class by hand abandons a link still waiting to open, even once closed.
  function openSessionByHand(session: ClassSession) {
    setPendingRouteSession(null);
    openSession(session);
  }

  function closeSelectedSession() {
    setAttendanceError(null);
    setDeleteError(null);
    setSessionAttendanceRefresh(clearSessionAttendanceRefresh());
    setSelectedSession(null);
  }

  function closeAddClass() {
    if (!isCreatingClass) {
      setShowAddClass(false);
    }
  }

  return {
    contentProps: {
      actionMessage,
      activeStudents,
      attendanceError,
      businessDate: config.businessDate,
      canManageSchedule,
      classFormInitialValues,
      createClassError,
      currentDate,
      deleteError,
      deleteInFlight,
      isCreatingClass,
      isRefreshingStudentRoster,
      isSelectedSessionAttendanceReady: isSessionAttendanceReady(
        sessionAttendanceRefresh,
        selectedSession?.id ?? null,
      ),
      pendingAttendanceIds,
      programFilter,
      programs,
      routeTargetNotice:
        routeTargetNotice?.rangeKey === loadRangeKey ? routeTargetNotice.message : null,
      scheduleLoadError,
      hasLoadedRange,
      isRefreshingRange: refreshingRangeKey === loadRangeKey,
      selectedSession,
      selectedSessionAttendance,
      studentRosterLoadError,
      isStudentRosterComplete: isCompleteScheduleRoster({
        studentsLoaded,
        studentsMayBePartial,
      }),
      sessions,
      showAddClass,
      studioTimezone: config.studioTimezone,
      templates,
      view,
      onCreateClass: handleCreateClass,
      onDeleteSelectedSeries:
        canManageSchedule && selectedSession?.template_id
          ? async () => {
              await handleDeleteSelectedSession("series");
            }
          : undefined,
      onDeleteSelectedSession: async () => {
        await handleDeleteSelectedSession("session");
      },
      onDismissActionMessage: () => setActionMessage(null),
      onDismissAttendanceError: () => setAttendanceError(null),
      onDismissCreateClassError: () => setCreateClassError(null),
      onDismissRouteTargetNotice: () => setRouteTargetNotice(null),
      onRetryRange: () => setRangeLoadAttempt((value) => value + 1),
      onDismissScheduleLoadError: () => setScheduleLoadError(null),
      onDismissStudentRosterLoadError: () => setStudentRosterLoadError(null),
      onJumpToToday: jumpToToday,
      onNavigate: navigate,
      onOpenAddClass: openAddClass,
      onOpenSession: openSessionByHand,
      onCloseAddClass: closeAddClass,
      onCloseSelectedSession: closeSelectedSession,
      onProgramFilterChange: setProgramFilter,
      onSelectDate: setCurrentDate,
      onToggleAttendance: handleToggleAttendance,
      onViewChange: setView,
    },
  };
}

export type SchedulePageController = ReturnType<typeof useSchedulePageController>;
