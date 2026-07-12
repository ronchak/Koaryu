import type { AttendanceRecord, ClassSession, Student } from "@/types";
import { differenceInLocalDateKeys, toLocalDateKey } from "./date.ts";

export interface StudentInactivityRow {
  student: Student;
  daysInactive: number;
  lastAttendanceDate?: string;
  referenceDate: string;
}

export function formatInactivityDaysForRange(
  row: StudentInactivityRow,
  inactivityThreshold: number
) {
  return row.daysInactive <= inactivityThreshold
    ? String(row.daysInactive)
    : `${inactivityThreshold}+`;
}

export function todayDateString() {
  return toLocalDateKey();
}

function diffInDays(from: string, to: string) {
  return differenceInLocalDateKeys(from, to);
}

export function isStudentOnHoldNow(student: Pick<Student, "status" | "hold_start_date" | "hold_end_date">, today = todayDateString()) {
  if (student.status === "paused") {
    return true;
  }

  if (!student.hold_start_date) {
    return false;
  }

  if (student.hold_start_date > today) {
    return false;
  }

  if (!student.hold_end_date) {
    return true;
  }

  return student.hold_end_date >= today;
}

export function buildStudentInactivityRows(
  students: Student[],
  sessions: ClassSession[],
  attendance: AttendanceRecord[],
  today = todayDateString()
): StudentInactivityRow[] {
  const sessionDateById = new Map(sessions.map((session) => [session.id, session.date]));
  const lastAttendanceByStudent = new Map<string, string>();

  for (const record of attendance) {
    if (record.status === "absent") {
      continue;
    }

    const sessionDate = sessionDateById.get(record.session_id) || record.checked_in_at.slice(0, 10);
    if (sessionDate > today) {
      continue;
    }

    const previousDate = lastAttendanceByStudent.get(record.student_id);
    if (!previousDate || sessionDate > previousDate) {
      lastAttendanceByStudent.set(record.student_id, sessionDate);
    }
  }

  return students
    .filter((student) => student.status === "active" || student.status === "trialing" || student.status === "paused")
    .filter((student) => !isStudentOnHoldNow(student, today))
    .map((student) => {
      const lastAttendanceDate = lastAttendanceByStudent.get(student.id);
      const referenceDate = lastAttendanceDate || student.membership_start_date || student.created_at.slice(0, 10);

      return {
        student,
        daysInactive: diffInDays(referenceDate, today),
        lastAttendanceDate,
        referenceDate,
      };
    })
    .sort((a, b) => b.daysInactive - a.daysInactive);
}
