import type { AttendanceRecord, AttendanceStatus, ClassSession, ClassTemplate } from "@/types";
import { getLatestAttendanceRecord } from "./attendance-record-model.ts";

const ATTENDANCE_TOGGLE_CYCLE: AttendanceStatus[] = ["present", "late", "absent"];

export interface AttendanceToggleTransition {
  existing: AttendanceRecord | null;
  nextStatus: AttendanceStatus | null;
  previousStatus: AttendanceStatus | null;
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
}: RunOptimisticAttendanceToggleOptions) {
  const transition = getAttendanceToggleTransition(attendance, sessionId, studentId);
  const { existing, nextStatus, previousStatus } = transition;
  const optimisticRecord = nextStatus
    ? existing
      ? { ...existing, status: nextStatus, checked_in_at: checkedInAt }
      : {
          id: optimisticId,
          studio_id: "",
          session_id: sessionId,
          student_id: studentId,
          status: nextStatus,
          checked_in_at: checkedInAt,
          is_cross_program: false,
          counts_toward_eligibility: true,
          student_name: name,
        }
    : null;
  const countDelta = toAttendanceCountDelta(previousStatus, nextStatus);

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
        replaceStudentAttendance(current, sessionId, studentId, existing)
      );
      commitSessionCountDelta(-countDelta);
    }
    throw error;
  }
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
