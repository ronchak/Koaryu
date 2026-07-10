import { useCallback, type Dispatch, type SetStateAction } from "react";

import { api } from "@/lib/api";
import {
  compareSessions,
  getPreviewTemplateSessionDates,
  mergeAttendanceForSessions,
  mergeSessionsForRange,
  normalizeAttendanceRecords,
  getAttendanceToggleTransition,
  runOptimisticAttendanceToggle,
  toAttendanceCountDelta,
  updateSessionAttendanceCount,
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
  sessionsRef,
  setAttendance,
  setSessions,
  setTemplates,
  templatesRef,
}: UseStoreScheduleActionsOptions) {
  const refreshScheduleRange = useCallback(async (
    startDate: string,
    endDate: string
  ): Promise<ClassSession[]> => {
    if (isPreviewMode) {
      return sessionsRef.current.filter((session) => session.date >= startDate && session.date <= endDate);
    }

    const request = beginLiveAuthRequest();
    const rangeSessions = await api.get<ClassSession[]>(
      `/schedule/sessions?start_date=${startDate}&end_date=${endDate}`,
      request.token
    );
    if (!request.isCurrent()) {
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
    const attendanceQuery = rangeSessions.length >= SCHEDULE_ATTENDANCE_BULK_THRESHOLD
      ? `/schedule/attendance?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`
      : `/schedule/attendance?${rangeSessions
          .map((sessionItem) => `session_ids=${encodeURIComponent(sessionItem.id)}`)
          .join("&")}`;

    if (rangeSessions.length > 0) {
      void api
        .get<AttendanceRecord[]>(attendanceQuery, request.token)
        .then((records) => {
          if (!request.isCurrent()) {
            return;
          }
          setAttendance((current) =>
            mergeAttendanceForSessions(
              current,
              normalizeAttendanceRecords(records),
              replacedSessionIds
            )
          );
        })
        .catch((error) => {
          console.error("Failed to refresh schedule attendance", error);
        });
    } else {
      setAttendance((current) =>
        mergeAttendanceForSessions(current, [], replacedSessionIds)
      );
    }
    return rangeSessions;
  }, [beginLiveAuthRequest, isPreviewMode, sessionsRef, setAttendance, setSessions]);

  const refreshSessionAttendance = useCallback(async (
    sessionId: string
  ): Promise<AttendanceRecord[]> => {
    if (isPreviewMode) {
      return attendanceRef.current.filter((record) => record.session_id === sessionId);
    }

    const request = beginLiveAuthRequest();
    const records = await api.get<AttendanceRecord[]>(
      `/schedule/attendance?session_ids=${encodeURIComponent(sessionId)}`,
      request.token
    );
    const normalizedRecords = normalizeAttendanceRecords(records);
    if (!request.isCurrent()) {
      return normalizedRecords;
    }
    setAttendance((current) => mergeAttendanceForSessions(current, normalizedRecords, [sessionId]));
    return normalizedRecords;
  }, [attendanceRef, beginLiveAuthRequest, isPreviewMode, setAttendance]);

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

    const liveRequest = beginLiveAuthRequest();
    const result = await api.post<ClassTemplate>("/schedule/templates", data, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return result;
    }
    setTemplates((current) =>
      [...current, result].sort((left, right) => {
        const dayCompare = left.day_of_week - right.day_of_week;
        if (dayCompare !== 0) {
          return dayCompare;
        }
        return left.start_time.localeCompare(right.start_time);
      })
    );
    return result;
  }, [beginLiveAuthRequest, isPreviewMode, persistSessions, persistTemplates, sessionsRef, setTemplates, templatesRef]);

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

    const liveRequest = beginLiveAuthRequest();
    const result = await api.post<ClassSession>("/schedule/sessions", data, liveRequest.token);
    if (!liveRequest.isCurrent()) {
      return;
    }
    setSessions((current) => [...current, result].sort(compareSessions));
  }, [beginLiveAuthRequest, isPreviewMode, persistSessions, sessionsRef, setSessions]);

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

    const liveRequest = beginLiveAuthRequest();
    const query = scope === "future_series" ? "?scope=future_series" : "";
    await api.delete(`/schedule/sessions/${sessionId}${query}`, liveRequest.token);
    if (!liveRequest.isCurrent()) {
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
  }, [
    attendanceRef,
    beginLiveAuthRequest,
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
      const { existing, nextStatus, previousStatus } = getAttendanceToggleTransition(
        attendanceRef.current,
        sessionId,
        studentId
      );
      let next: AttendanceRecord[];
      if (existing) {
        if (!nextStatus) {
          next = attendanceRef.current.filter((record) => record !== existing);
        } else {
          next = attendanceRef.current.map((record) =>
            record === existing ? { ...record, status: nextStatus } : record
          );
        }
        setSessions((current) =>
          updateSessionAttendanceCount(
            current,
            sessionId,
            toAttendanceCountDelta(previousStatus, nextStatus)
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
            status: nextStatus as AttendanceStatus,
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

    const liveRequest = beginLiveAuthRequest();
    await runOptimisticAttendanceToggle({
      attendance: attendanceRef.current,
      checkedInAt: new Date().toISOString(),
      commitAttendance: (update) => setAttendance(update),
      commitSessionCountDelta: (delta) => {
        setSessions((current) => updateSessionAttendanceCount(current, sessionId, delta));
      },
      isCurrent: liveRequest.isCurrent,
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
  }, [
    attendanceRef,
    beginLiveAuthRequest,
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
