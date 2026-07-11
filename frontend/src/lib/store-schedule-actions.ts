import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";

import { api } from "@/lib/api";
import {
  beginScheduleMutationState,
  compareSessions,
  finishScheduleMutationState,
  getPreviewTemplateSessionDates,
  isScheduleReadCurrent,
  shouldReconcileSchedule,
  mergeAttendanceForSessions,
  mergeSessionsForRange,
  normalizeAttendanceRecords,
  runOptimisticAttendanceToggle,
  shouldRetryScheduleReadAfterCoordinatorChange,
  setScheduleRequestedRangeState,
  updateSessionAttendanceCount,
  type ScheduleCoordinatorState,
  type SessionAttendanceRefreshResult,
} from "@/lib/schedule-store-model";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import { localId } from "@/lib/store-storage";
import type {
  AttendanceRecord,
  ClassSession,
  ClassSessionCreate,
  ClassSessionDeleteScope,
  ClassTemplate,
  ClassTemplateCreate,
} from "@/types";

const SCHEDULE_ATTENDANCE_BULK_THRESHOLD = 3;

interface UseStoreScheduleActionsOptions {
  attendanceRef: StoreRef<AttendanceRecord[]>;
  beginLiveAuthRequest: BeginLiveAuthRequest;
  isPreviewMode: boolean;
  persistAttendance: (next: AttendanceRecord[]) => void;
  persistSessions: (next: ClassSession[]) => void;
  persistTemplates: (next: ClassTemplate[]) => void;
  reconcileSchedule: () => Promise<void>;
  scheduleCoordinatorRef: StoreRef<ScheduleCoordinatorState>;
  sessionsRef: StoreRef<ClassSession[]>;
  setAttendance: Dispatch<SetStateAction<AttendanceRecord[]>>;
  setSessions: Dispatch<SetStateAction<ClassSession[]>>;
  setTemplates: Dispatch<SetStateAction<ClassTemplate[]>>;
  templatesRef: StoreRef<ClassTemplate[]>;
}

export function useStoreScheduleActions({
  attendanceRef,
  beginLiveAuthRequest,
  isPreviewMode,
  persistAttendance,
  persistSessions,
  persistTemplates,
  reconcileSchedule,
  scheduleCoordinatorRef,
  sessionsRef,
  setAttendance,
  setSessions,
  setTemplates,
  templatesRef,
}: UseStoreScheduleActionsOptions) {
  const scheduleMutationWaitersRef = useRef(new Set<() => void>());

  const releaseScheduleMutationWaiters = useCallback(() => {
    if (scheduleCoordinatorRef.current.mutationsInFlight !== 0) {
      return;
    }
    const waiters = [...scheduleMutationWaitersRef.current];
    scheduleMutationWaitersRef.current.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }, [scheduleCoordinatorRef]);

  const waitForScheduleMutationSettlement = useCallback(() => {
    if (scheduleCoordinatorRef.current.mutationsInFlight === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const settle = () => resolve();
      scheduleMutationWaitersRef.current.add(settle);
      if (scheduleCoordinatorRef.current.mutationsInFlight === 0) {
        scheduleMutationWaitersRef.current.delete(settle);
        resolve();
      }
    });
  }, [scheduleCoordinatorRef]);

  const beginScheduleMutation = useCallback(() => {
    const request = beginLiveAuthRequest();
    const generation = scheduleCoordinatorRef.current.generation;
    scheduleCoordinatorRef.current = beginScheduleMutationState(scheduleCoordinatorRef.current);
    let finished = false;

    return {
      request,
      isCurrent: () => request.isCurrent()
        && scheduleCoordinatorRef.current.generation === generation,
      finish: async () => {
        if (finished) {
          return;
        }
        finished = true;
        const beforeFinish = scheduleCoordinatorRef.current;
        const afterFinish = finishScheduleMutationState(beforeFinish, generation);
        scheduleCoordinatorRef.current = afterFinish;
        try {
          if (
            afterFinish !== beforeFinish
            && shouldReconcileSchedule(afterFinish)
          ) {
            await reconcileSchedule();
          }
        } catch (error) {
          console.error("Failed to reconcile schedule after a mutation", error);
        } finally {
          releaseScheduleMutationWaiters();
        }
      },
    };
  }, [beginLiveAuthRequest, reconcileSchedule, releaseScheduleMutationWaiters, scheduleCoordinatorRef]);

  const refreshScheduleRange = useCallback(async (
    startDate: string,
    endDate: string
  ): Promise<ClassSession[]> => {
    if (isPreviewMode) {
      return sessionsRef.current.filter((session) => session.date >= startDate && session.date <= endDate);
    }

    try {
      const request = beginLiveAuthRequest();
      const coordinator = scheduleCoordinatorRef.current;
      const requestSequence = coordinator.rangeRequestSequence + 1;
      const attendanceRequestSequence = coordinator.attendanceRequestSequence + 1;
      scheduleCoordinatorRef.current = {
        ...setScheduleRequestedRangeState(coordinator, { startDate, endDate }),
        attendanceRequestSequence,
        rangeRequestSequence: requestSequence,
      };
      const dataRevision = coordinator.dataRevision;
      const generation = coordinator.generation;
      const isCurrentRequest = () => isScheduleReadCurrent({
        authCurrent: request.isCurrent(),
        currentGeneration: scheduleCoordinatorRef.current.generation,
        currentDataRevision: scheduleCoordinatorRef.current.dataRevision,
        currentRequestSequence: scheduleCoordinatorRef.current.rangeRequestSequence,
        dataRevisionAtStart: dataRevision,
        generationAtStart: generation,
        mutationsInFlight: scheduleCoordinatorRef.current.mutationsInFlight,
        requestSequenceAtStart: requestSequence,
      });
      const attendanceIsCurrent = () => isScheduleReadCurrent({
        authCurrent: request.isCurrent(),
        currentGeneration: scheduleCoordinatorRef.current.generation,
        currentDataRevision: scheduleCoordinatorRef.current.dataRevision,
        currentRequestSequence: scheduleCoordinatorRef.current.attendanceRequestSequence,
        dataRevisionAtStart: dataRevision,
        generationAtStart: generation,
        mutationsInFlight: scheduleCoordinatorRef.current.mutationsInFlight,
        requestSequenceAtStart: attendanceRequestSequence,
      });
      const rangeSessions = await api.post<ClassSession[]>(
        `/schedule/sessions/materialize?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`,
        {},
        request.token
      );
      const attendanceQuery = rangeSessions.length >= SCHEDULE_ATTENDANCE_BULK_THRESHOLD
        ? `/schedule/attendance?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`
        : `/schedule/attendance?${rangeSessions
            .map((sessionItem) => `session_ids=${encodeURIComponent(sessionItem.id)}`)
            .join("&")}`;

      let attendanceRecords: AttendanceRecord[] | null = [];
      if (rangeSessions.length > 0) {
        try {
          attendanceRecords = normalizeAttendanceRecords(
            await api.get<AttendanceRecord[]>(attendanceQuery, request.token)
          );
        } catch (error) {
          attendanceRecords = null;
          console.error("Failed to refresh schedule attendance", error);
        }
      }

      if (!isCurrentRequest()) {
        return rangeSessions;
      }

      const replacedSessionIds = Array.from(
        new Set([
          ...sessionsRef.current
            .filter((session) => session.date >= startDate && session.date <= endDate)
            .map((session) => session.id),
          ...rangeSessions.map((session) => session.id),
        ])
      );

      setSessions((current) => mergeSessionsForRange(current, rangeSessions, startDate, endDate));
      if (attendanceRecords !== null && attendanceIsCurrent()) {
        setAttendance((current) =>
          mergeAttendanceForSessions(current, attendanceRecords, replacedSessionIds)
        );
      }
      return rangeSessions;
    } finally {
      if (shouldReconcileSchedule(scheduleCoordinatorRef.current)) {
        void reconcileSchedule().catch((error) => {
          console.error("Failed to reconcile schedule after a range refresh", error);
        });
      }
    }
  }, [
    beginLiveAuthRequest,
    isPreviewMode,
    reconcileSchedule,
    scheduleCoordinatorRef,
    sessionsRef,
    setAttendance,
    setSessions,
  ]);

  const refreshSessionAttendance = useCallback(async (
    sessionId: string
  ): Promise<SessionAttendanceRefreshResult> => {
    if (isPreviewMode) {
      return {
        committed: true,
        records: attendanceRef.current.filter((record) => record.session_id === sessionId),
      };
    }

    try {
      while (true) {
        const request = beginLiveAuthRequest();
        const coordinator = scheduleCoordinatorRef.current;
        const requestSequence = coordinator.attendanceRequestSequence + 1;
        scheduleCoordinatorRef.current = {
          ...coordinator,
          attendanceRequestSequence: requestSequence,
        };
        const dataRevision = coordinator.dataRevision;
        const generation = coordinator.generation;
        const records = await api.get<AttendanceRecord[]>(
          `/schedule/attendance?session_ids=${encodeURIComponent(sessionId)}`,
          request.token
        );
        const normalizedRecords = normalizeAttendanceRecords(records);
        const current = scheduleCoordinatorRef.current;
        const authCurrent = request.isCurrent();
        const generationCurrent = current.generation === generation;
        if (!isScheduleReadCurrent({
          authCurrent,
          currentGeneration: current.generation,
          currentDataRevision: current.dataRevision,
          currentRequestSequence: current.attendanceRequestSequence,
          dataRevisionAtStart: dataRevision,
          generationAtStart: generation,
          mutationsInFlight: current.mutationsInFlight,
          requestSequenceAtStart: requestSequence,
        })) {
          if (shouldRetryScheduleReadAfterCoordinatorChange(authCurrent, generationCurrent)) {
            continue;
          }
          if (current.mutationsInFlight > 0) {
            await waitForScheduleMutationSettlement();
            continue;
          }
          return { committed: false, records: normalizedRecords };
        }
        setAttendance((existing) =>
          mergeAttendanceForSessions(existing, normalizedRecords, [sessionId])
        );
        return { committed: true, records: normalizedRecords };
      }
    } finally {
      if (shouldReconcileSchedule(scheduleCoordinatorRef.current)) {
        void reconcileSchedule().catch((error) => {
          console.error("Failed to reconcile schedule after an attendance refresh", error);
        });
      }
    }
  }, [
    attendanceRef,
    beginLiveAuthRequest,
    isPreviewMode,
    reconcileSchedule,
    scheduleCoordinatorRef,
    setAttendance,
    waitForScheduleMutationSettlement,
  ]);

  const addTemplate = useCallback(async (data: ClassTemplateCreate): Promise<ClassTemplate> => {
    if (isPreviewMode) {
      const startDate = data.start_date || new Date().toISOString().split("T")[0];
      const newTemplate: ClassTemplate = {
        id: localId(),
        studio_id: "mock-studio",
        name: data.name,
        day_of_week: data.day_of_week,
        start_time: data.start_time,
        end_time: data.end_time,
        start_date: startDate,
        end_date: data.end_date,
        instructor_id: data.instructor_id,
        program_id: data.program_id,
        capacity: data.capacity,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      persistTemplates([...templatesRef.current, newTemplate]);

      const existingKeys = new Set(
        sessionsRef.current
          .filter((session) => session.template_id)
          .map((session) => `${session.template_id}:${session.date}`)
      );
      const generatedSessions = getPreviewTemplateSessionDates(newTemplate)
        .filter((dateValue) => !existingKeys.has(`${newTemplate.id}:${dateValue}`))
        .map((dateValue) => ({
          id: localId(),
          studio_id: "mock-studio",
          template_id: newTemplate.id,
          name: newTemplate.name,
          date: dateValue,
          start_time: newTemplate.start_time,
          end_time: newTemplate.end_time,
          instructor_id: newTemplate.instructor_id,
          program_id: newTemplate.program_id,
          capacity: newTemplate.capacity,
          status: "scheduled" as const,
          created_at: new Date().toISOString(),
          attendance_count: 0,
        }));
      if (generatedSessions.length > 0) {
        persistSessions([...sessionsRef.current, ...generatedSessions].sort(compareSessions));
      }
      return newTemplate;
    }

    const mutation = beginScheduleMutation();
    try {
      const result = await api.post<ClassTemplate>("/schedule/templates", data, mutation.request.token);
      if (mutation.isCurrent()) {
        setTemplates((current) =>
          [...current, result].sort((left, right) => {
            const dayCompare = left.day_of_week - right.day_of_week;
            if (dayCompare !== 0) {
              return dayCompare;
            }
            return left.start_time.localeCompare(right.start_time);
          })
        );
      }
      return result;
    } finally {
      await mutation.finish();
    }
  }, [beginScheduleMutation, isPreviewMode, persistSessions, persistTemplates, sessionsRef, setTemplates, templatesRef]);

  const addSession = useCallback(async (data: ClassSessionCreate) => {
    if (isPreviewMode) {
      const newSession: ClassSession = {
        id: localId(),
        studio_id: "mock-studio",
        name: data.name || "Untitled Class",
        date: data.date || new Date().toISOString().split("T")[0],
        start_time: data.start_time || "18:00",
        end_time: data.end_time || "19:30",
        capacity: data.capacity,
        status: "scheduled",
        created_at: new Date().toISOString(),
        attendance_count: 0,
      };
      persistSessions([...sessionsRef.current, newSession].sort(compareSessions));
      return;
    }

    const mutation = beginScheduleMutation();
    try {
      const result = await api.post<ClassSession>("/schedule/sessions", data, mutation.request.token);
      if (mutation.isCurrent()) {
        setSessions((current) => [...current, result].sort(compareSessions));
      }
    } finally {
      await mutation.finish();
    }
  }, [beginScheduleMutation, isPreviewMode, persistSessions, sessionsRef, setSessions]);

  const deleteSession = useCallback(async (
    sessionId: string,
    scope: ClassSessionDeleteScope = "session"
  ) => {
    const sessionToDelete = sessionsRef.current.find((session) => session.id === sessionId);
    if (!sessionToDelete) {
      throw new Error("Class session not found");
    }

    if (isPreviewMode) {
      if (scope === "future_series" && sessionToDelete.template_id) {
        const templateId = sessionToDelete.template_id;
        persistTemplates(
          templatesRef.current.map((template) =>
            template.id === templateId
              ? {
                  ...template,
                  is_active: false,
                  end_date: sessionToDelete.date,
                  updated_at: new Date().toISOString(),
                }
              : template
          )
        );
        persistSessions(
          sessionsRef.current.filter(
            (session) =>
              session.template_id !== templateId || session.date < sessionToDelete.date
          )
        );
        return;
      }

      persistSessions(sessionsRef.current.filter((session) => session.id !== sessionId));
      persistAttendance(attendanceRef.current.filter((record) => record.session_id !== sessionId));
      return;
    }

    const mutation = beginScheduleMutation();
    const query = scope === "future_series" ? "?scope=future_series" : "";
    try {
      await api.delete(`/schedule/sessions/${sessionId}${query}`, mutation.request.token);
      if (!mutation.isCurrent()) {
        return;
      }

      if (scope === "future_series" && sessionToDelete.template_id) {
        const templateId = sessionToDelete.template_id;
        const removedSessionIds = new Set(
          sessionsRef.current
            .filter(
              (session) =>
                session.template_id === templateId && session.date >= sessionToDelete.date
            )
            .map((session) => session.id)
        );
        setTemplates((current) =>
          current.map((template) =>
            template.id === templateId
              ? {
                  ...template,
                  is_active: false,
                  end_date: sessionToDelete.date,
                }
              : template
          )
        );
        setSessions((current) =>
          current.filter(
            (session) =>
              session.template_id !== templateId || session.date < sessionToDelete.date
          )
        );
        setAttendance((current) =>
          current.filter((record) => !removedSessionIds.has(record.session_id))
        );
        return;
      }

      setSessions((current) => current.filter((session) => session.id !== sessionId));
      setAttendance((current) => current.filter((record) => record.session_id !== sessionId));
    } finally {
      await mutation.finish();
    }
  }, [
    attendanceRef,
    beginScheduleMutation,
    isPreviewMode,
    persistAttendance,
    persistSessions,
    persistTemplates,
    sessionsRef,
    setAttendance,
    setSessions,
    setTemplates,
    templatesRef,
  ]);

  const toggleCheckIn = useCallback(async (
    sessionId: string,
    studentId: string,
    name: string
  ) => {
    const commitAttendance = (
      update: (current: AttendanceRecord[]) => AttendanceRecord[]
    ) => {
      if (isPreviewMode) {
        const next = update(attendanceRef.current);
        attendanceRef.current = next;
        persistAttendance(next);
      } else {
        setAttendance((current) => {
          const next = update(current);
          attendanceRef.current = next;
          return next;
        });
      }
    };

    if (isPreviewMode) {
      await runOptimisticAttendanceToggle({
        attendance: attendanceRef.current,
        checkedInAt: new Date().toISOString(),
        commitAttendance,
        commitSessionCountDelta: (delta) => {
          setSessions((current) => updateSessionAttendanceCount(current, sessionId, delta));
        },
        name,
        optimisticId: localId(),
        request: async () => null,
        sessionId,
        studentId,
        studioId: "mock-studio",
      });
      return;
    }

    const mutation = beginScheduleMutation();
    const liveRequest = mutation.request;
    try {
      await runOptimisticAttendanceToggle({
        attendance: attendanceRef.current,
        checkedInAt: new Date().toISOString(),
        commitAttendance,
        commitSessionCountDelta: (delta) => {
          setSessions((current) => updateSessionAttendanceCount(current, sessionId, delta));
        },
        isCurrent: mutation.isCurrent,
        name,
        optimisticId: `optimistic-${sessionId}-${studentId}`,
        request: async (nextStatus) => {
          if (!nextStatus) {
            await api.delete(
              `/schedule/attendance?session_id=${encodeURIComponent(sessionId)}&student_id=${encodeURIComponent(studentId)}`,
              liveRequest.token
            );
            return null;
          }

          return api.post<AttendanceRecord>(
            "/schedule/attendance",
            { session_id: sessionId, student_id: studentId, status: nextStatus },
            liveRequest.token
          );
        },
        sessionId,
        studentId,
      });
    } finally {
      await mutation.finish();
    }
  }, [
    attendanceRef,
    beginScheduleMutation,
    isPreviewMode,
    persistAttendance,
    setAttendance,
    setSessions,
  ]);

  return {
    addSession,
    addTemplate,
    deleteSession,
    refreshScheduleRange,
    refreshSessionAttendance,
    toggleCheckIn,
  };
}
