import { useCallback, type Dispatch, type SetStateAction } from "react";

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
  toAttendanceCountDelta,
  updateSessionAttendanceCount,
  type ScheduleCoordinatorState,
} from "@/lib/schedule-store-model";
import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import { localId } from "@/lib/store-storage";
import type {
  AttendanceRecord,
  AttendanceStatus,
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
        scheduleCoordinatorRef.current = finishScheduleMutationState(beforeFinish, generation);
        if (
          beforeFinish.generation === generation
          && shouldReconcileSchedule(scheduleCoordinatorRef.current)
        ) {
          try {
            await reconcileSchedule();
          } catch (error) {
            console.error("Failed to reconcile schedule after a mutation", error);
          }
        }
      },
    };
  }, [beginLiveAuthRequest, reconcileSchedule, scheduleCoordinatorRef]);

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
        ...coordinator,
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
  ): Promise<AttendanceRecord[]> => {
    if (isPreviewMode) {
      return attendanceRef.current.filter((record) => record.session_id === sessionId);
    }

    try {
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
      if (!isScheduleReadCurrent({
        authCurrent: request.isCurrent(),
        currentGeneration: scheduleCoordinatorRef.current.generation,
        currentDataRevision: scheduleCoordinatorRef.current.dataRevision,
        currentRequestSequence: scheduleCoordinatorRef.current.attendanceRequestSequence,
        dataRevisionAtStart: dataRevision,
        generationAtStart: generation,
        mutationsInFlight: scheduleCoordinatorRef.current.mutationsInFlight,
        requestSequenceAtStart: requestSequence,
      })) {
        return normalizedRecords;
      }
      setAttendance((current) => mergeAttendanceForSessions(current, normalizedRecords, [sessionId]));
      return normalizedRecords;
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
    if (isPreviewMode) {
      const existing = attendanceRef.current.find(
        (record) => record.session_id === sessionId && record.student_id === studentId
      );
      let next: AttendanceRecord[];
      if (existing) {
        const cycle: AttendanceStatus[] = ["present", "late", "absent"];
        const idx = cycle.indexOf(existing.status);
        const previousStatus = existing.status;
        let nextStatusForCount: AttendanceStatus | null = previousStatus;
        if (idx === cycle.length - 1) {
          next = attendanceRef.current.filter((record) => record !== existing);
          nextStatusForCount = null;
        } else {
          next = attendanceRef.current.map((record) =>
            record === existing ? { ...record, status: cycle[idx + 1] } : record
          );
          nextStatusForCount = cycle[idx + 1];
        }
        setSessions((current) =>
          updateSessionAttendanceCount(
            current,
            sessionId,
            toAttendanceCountDelta(previousStatus, nextStatusForCount)
          )
        );
      } else {
        next = [
          ...attendanceRef.current,
          {
            id: localId(),
            studio_id: "mock-studio",
            session_id: sessionId,
            student_id: studentId,
            status: "present" as AttendanceStatus,
            checked_in_at: new Date().toISOString(),
            is_cross_program: false,
            counts_toward_eligibility: true,
            student_name: name,
          },
        ];
        setSessions((current) =>
          updateSessionAttendanceCount(
            current,
            sessionId,
            toAttendanceCountDelta(null, "present")
          )
        );
      }
      persistAttendance(next);
      return;
    }

    const mutation = beginScheduleMutation();
    const liveRequest = mutation.request;
    const cycle: AttendanceStatus[] = ["present", "late", "absent"];
    const existing = attendanceRef.current.find(
      (record) => record.session_id === sessionId && record.student_id === studentId
    );
    const previousStatus = existing?.status ?? null;
    const currentIndex = existing ? cycle.indexOf(existing.status) : -1;
    const nextStatus: AttendanceStatus | null =
      existing && currentIndex === cycle.length - 1
        ? null
        : cycle[(currentIndex + 1 + cycle.length) % cycle.length];

    setAttendance((current) => {
      const next = current.filter(
        (record) => !(record.session_id === sessionId && record.student_id === studentId)
      );
      if (nextStatus) {
        next.push(
          existing
            ? { ...existing, status: nextStatus }
            : {
                id: `optimistic-${sessionId}-${studentId}`,
                studio_id: "",
                session_id: sessionId,
                student_id: studentId,
                status: nextStatus,
                checked_in_at: new Date().toISOString(),
                is_cross_program: false,
                counts_toward_eligibility: true,
                student_name: name,
              }
        );
      }
      return next;
    });
    setSessions((current) =>
      updateSessionAttendanceCount(
        current,
        sessionId,
        toAttendanceCountDelta(previousStatus, nextStatus)
      )
    );

    try {
      if (!nextStatus) {
        await api.delete(
          `/schedule/attendance?session_id=${encodeURIComponent(sessionId)}&student_id=${encodeURIComponent(studentId)}`,
          liveRequest.token
        );
        return;
      }

      const result = await api.post<AttendanceRecord>(
        "/schedule/attendance",
        {
          session_id: sessionId,
          student_id: studentId,
          status: nextStatus,
        },
        liveRequest.token
      );

      if (!mutation.isCurrent()) {
        return;
      }
      setAttendance((current) => {
        const next = current.filter(
          (record) => !(record.session_id === sessionId && record.student_id === studentId)
        );
        next.push({
          ...result,
          student_name: existing?.student_name || name,
        });
        return next;
      });
    } catch (error) {
      if (mutation.isCurrent()) {
        setAttendance((current) => {
          const next = current.filter(
            (record) => !(record.session_id === sessionId && record.student_id === studentId)
          );
          if (existing) {
            next.push(existing);
          }
          return next;
        });
        setSessions((current) =>
          updateSessionAttendanceCount(
            current,
            sessionId,
            toAttendanceCountDelta(nextStatus, previousStatus)
          )
        );
      }
      throw error;
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
