import type { AttendanceRecord, ClassSession, Student } from "@/types";

export type SchedulePageView = "month" | "week" | "day";

export function formatScheduleDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getScheduleWeekDates(base: Date): Date[] {
  const start = new Date(base);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(start);
    current.setDate(start.getDate() + index);
    return current;
  });
}

export function getScheduleMonthGridRange(base: Date) {
  const firstOfMonth = new Date(base.getFullYear(), base.getMonth(), 1, 12);
  const start = new Date(firstOfMonth);
  start.setDate(firstOfMonth.getDate() - firstOfMonth.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 41);
  return { start, end };
}

export function getVisibleScheduleRange(currentDate: Date, view: SchedulePageView) {
  if (view === "day") {
    const key = formatScheduleDateKey(currentDate);
    return { start: key, end: key };
  }

  if (view === "month") {
    const { start, end } = getScheduleMonthGridRange(currentDate);
    return {
      start: formatScheduleDateKey(start),
      end: formatScheduleDateKey(end),
    };
  }

  const weekDates = getScheduleWeekDates(currentDate);
  return {
    start: formatScheduleDateKey(weekDates[0]),
    end: formatScheduleDateKey(weekDates[6]),
  };
}

export function navigateScheduleDate(currentDate: Date, view: SchedulePageView, direction: number) {
  const next = new Date(currentDate);
  if (view === "day") {
    next.setDate(next.getDate() + direction);
  } else if (view === "month") {
    next.setMonth(next.getMonth() + direction);
  } else {
    next.setDate(next.getDate() + direction * 7);
  }
  return next;
}

export function recurringClassOverlapsRange(
  recurrence: { startDate: string; endDate?: string | null },
  visibleRange: { start: string; end: string }
) {
  return recurrence.startDate <= visibleRange.end
    && (!recurrence.endDate || recurrence.endDate >= visibleRange.start);
}

export function getActiveScheduleStudents(students: Student[]) {
  return students.filter((student) => student.status === "active" || student.status === "trialing");
}

export function getScheduleSessionAttendance(
  attendance: AttendanceRecord[],
  session: Pick<ClassSession, "id"> | null
) {
  if (!session) {
    return [];
  }

  return attendance.filter((record) => record.session_id === session.id);
}
