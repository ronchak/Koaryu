"use client";

import { useEffect, useMemo, useState } from "react";
import type { ClassFormSubmitPayload } from "@/lib/class-form-model";
import {
  getActiveScheduleStudents,
  getScheduleSessionAttendance,
  getVisibleScheduleRange,
  navigateScheduleDate,
  recurringClassOverlapsRange,
  type SchedulePageView,
} from "@/lib/schedule-page-model";
import type { ScheduleSessionDeleteScope } from "@/lib/session-detail-model";
import type {
  ProgramsStoreContextValue,
  ScheduleStoreContextValue,
  StudentsStoreContextValue,
} from "@/lib/store-contexts";
import type { ClassSession } from "@/types";

type SchedulePageControllerOptions = {
  programsStore: Pick<ProgramsStoreContextValue, "programs">;
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
  studentsStore: Pick<StudentsStoreContextValue, "refreshStudents" | "students" | "studentsMayBePartial">;
};

export function useSchedulePageController({
  programsStore,
  scheduleStore,
  studentsStore,
}: SchedulePageControllerOptions) {
  const { refreshStudents, students, studentsMayBePartial } = studentsStore;
  const { programs } = programsStore;
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
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<SchedulePageView>("week");
  const [programFilter, setProgramFilter] = useState("");
  const [selectedSession, setSelectedSession] = useState<ClassSession | null>(null);
  const [showAddClass, setShowAddClass] = useState(false);
  const [isCreatingClass, setIsCreatingClass] = useState(false);
  const [createClassError, setCreateClassError] = useState<string | null>(null);
  const [scheduleLoadError, setScheduleLoadError] = useState<string | null>(null);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);
  const [studentRosterLoadError, setStudentRosterLoadError] = useState<string | null>(null);
  const [isRefreshingStudentRoster, setIsRefreshingStudentRoster] = useState(false);
  const [pendingAttendanceId, setPendingAttendanceId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState<ScheduleSessionDeleteScope | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const visibleRange = useMemo(
    () => getVisibleScheduleRange(currentDate, view),
    [currentDate, view]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadRange() {
      setScheduleLoadError(null);
      try {
        await refreshScheduleRange(visibleRange.start, visibleRange.end);
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load schedule range", error);
          setScheduleLoadError("Could not load this calendar range. Please try again.");
        }
      }
    }

    void loadRange();

    return () => {
      cancelled = true;
    };
  }, [refreshScheduleRange, visibleRange.end, visibleRange.start]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    void refreshSessionAttendance(selectedSession.id).catch((error) => {
      console.error("Failed to load session attendance", error);
    });
  }, [refreshSessionAttendance, selectedSession]);

  const activeStudents = useMemo(
    () => getActiveScheduleStudents(students),
    [students]
  );
  const selectedSessionAttendance = useMemo(
    () => getScheduleSessionAttendance(attendance, selectedSession),
    [attendance, selectedSession]
  );

  function navigate(direction: number) {
    setCurrentDate((date) => navigateScheduleDate(date, view, direction));
  }

  function jumpToToday() {
    setCurrentDate(new Date());
  }

  async function handleCreateClass(payload: ClassFormSubmitPayload) {
    setCreateClassError(null);
    setIsCreatingClass(true);

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
        await addTemplate({
          name: payload.name,
          day_of_week: payload.recurrence.dayOfWeek,
          start_time: payload.startTime,
          end_time: payload.endTime,
          start_date: payload.recurrence.startDate,
          end_date: payload.recurrence.endDate,
          program_id: payload.program_id,
          capacity: payload.capacity,
        });

        if (recurringClassOverlapsRange(payload.recurrence, visibleRange)) {
          await refreshScheduleRange(visibleRange.start, visibleRange.end);
        }
      }
      setShowAddClass(false);
      setActionMessage(
        payload.kind === "single_session"
          ? "Class added to the schedule."
          : "Recurring class created and visible sessions refreshed."
      );
    } catch (error) {
      console.error("Failed to create class", error);
      setCreateClassError(
        error instanceof Error ? error.message : "Could not create this class. Please try again."
      );
    } finally {
      setIsCreatingClass(false);
    }
  }

  async function handleToggleAttendance(sessionId: string, studentId: string, name: string) {
    setAttendanceError(null);
    setPendingAttendanceId(studentId);
    try {
      await toggleCheckIn(sessionId, studentId, name);
    } catch (error) {
      console.error("Failed to update attendance", error);
      setAttendanceError("Could not update attendance. Please try again.");
    } finally {
      setPendingAttendanceId(null);
    }
  }

  async function handleDeleteSelectedSession(scope: ScheduleSessionDeleteScope) {
    if (!selectedSession) {
      return;
    }

    setDeleteError(null);
    setDeleteInFlight(scope);

    try {
      await deleteSession(
        selectedSession.id,
        scope === "series" ? "future_series" : "session"
      );
      setSelectedSession(null);
      setActionMessage(scope === "series" ? "Recurring class series removed." : "Class removed from the schedule.");
    } catch (error) {
      console.error("Failed to delete session", error);
      setDeleteError(
        error instanceof Error ? error.message : "Could not delete this class. Please try again."
      );
    } finally {
      setDeleteInFlight(null);
    }
  }

  function openAddClass() {
    setCreateClassError(null);
    setShowAddClass(true);
  }

  function openSession(session: ClassSession) {
    setAttendanceError(null);
    setDeleteError(null);
    setStudentRosterLoadError(null);
    setSelectedSession(session);
    if (studentsMayBePartial) {
      setIsRefreshingStudentRoster(true);
      void refreshStudents()
        .catch((error) => {
          console.error("Failed to load complete student roster", error);
          setStudentRosterLoadError("Could not load the complete roster for attendance.");
        })
        .finally(() => setIsRefreshingStudentRoster(false));
    }
  }

  function closeSelectedSession() {
    setAttendanceError(null);
    setDeleteError(null);
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
      createClassError,
      currentDate,
      deleteError,
      deleteInFlight,
      isCreatingClass,
      isRefreshingStudentRoster,
      pendingAttendanceId,
      programFilter,
      programs,
      scheduleLoadError,
      selectedSession,
      selectedSessionAttendance,
      studentRosterLoadError,
      sessions,
      showAddClass,
      templates,
      view,
      onCreateClass: handleCreateClass,
      onDeleteSelectedSeries: selectedSession?.template_id
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
      onDismissScheduleLoadError: () => setScheduleLoadError(null),
      onDismissStudentRosterLoadError: () => setStudentRosterLoadError(null),
      onJumpToToday: jumpToToday,
      onNavigate: navigate,
      onOpenAddClass: openAddClass,
      onOpenSession: openSession,
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
