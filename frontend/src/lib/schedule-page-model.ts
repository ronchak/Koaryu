import type { AttendanceRecord, ClassSession, Student } from "@/types";

export type SchedulePageView = "month" | "week" | "day";

export type ScheduleTimeItem = {
  id: string;
  start_time: string;
  end_time: string;
};

export type ScheduleTimeBlock<T extends ScheduleTimeItem> = {
  item: T;
  startMinute: number;
  endMinute: number;
  lane: number;
  laneCount: number;
  overlaps: boolean;
};

export const DEFAULT_SCHEDULE_PAGE_VIEW: SchedulePageView = "month";

export const SCHEDULE_CANVAS_PIXELS_PER_HOUR = 72;

export function scheduleTimeToMinute(value: string) {
  const [hoursText = "0", minutesText = "0"] = value.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }
  return Math.max(0, Math.min(24 * 60, hours * 60 + minutes));
}

export function getScheduleTimeCanvasBounds(items: ReadonlyArray<ScheduleTimeItem>) {
  const defaultStart = 6 * 60;
  const defaultEnd = 22 * 60;
  if (items.length === 0) {
    return { startMinute: defaultStart, endMinute: defaultEnd };
  }

  const earliest = Math.min(...items.map((item) => scheduleTimeToMinute(item.start_time)));
  const latest = Math.max(...items.map((item) => scheduleTimeToMinute(item.end_time)));
  return {
    startMinute: Math.min(defaultStart, Math.floor(earliest / 60) * 60),
    endMinute: Math.max(defaultEnd, Math.ceil(latest / 60) * 60),
  };
}

export function layoutScheduleTimeItems<T extends ScheduleTimeItem>(
  items: ReadonlyArray<T>
): ScheduleTimeBlock<T>[] {
  const sorted: ScheduleTimeBlock<T>[] = items
    .map((item) => {
      const startMinute = scheduleTimeToMinute(item.start_time);
      return {
        item,
        startMinute,
        endMinute: Math.max(startMinute + 15, scheduleTimeToMinute(item.end_time)),
        lane: 0,
        laneCount: 1,
        overlaps: false,
      };
    })
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.item.id.localeCompare(b.item.id));

  let groupStart = 0;
  while (groupStart < sorted.length) {
    let groupEnd = groupStart + 1;
    let latestEnd = sorted[groupStart].endMinute;
    while (groupEnd < sorted.length && sorted[groupEnd].startMinute < latestEnd) {
      latestEnd = Math.max(latestEnd, sorted[groupEnd].endMinute);
      groupEnd += 1;
    }

    const laneEnds: number[] = [];
    for (let index = groupStart; index < groupEnd; index += 1) {
      const block = sorted[index];
      const availableLane = laneEnds.findIndex((endMinute) => endMinute <= block.startMinute);
      block.lane = availableLane === -1 ? laneEnds.length : availableLane;
      laneEnds[block.lane] = block.endMinute;
    }
    for (let index = groupStart; index < groupEnd; index += 1) {
      sorted[index].laneCount = laneEnds.length;
      sorted[index].overlaps = laneEnds.length > 1;
    }
    groupStart = groupEnd;
  }

  return sorted;
}

export type SessionAttendanceRefreshState = {
  sessionId: string | null;
  status: "idle" | "pending" | "ready" | "error";
};

export function beginSessionAttendanceRefresh(sessionId: string): SessionAttendanceRefreshState {
  return { sessionId, status: "pending" };
}

export function clearSessionAttendanceRefresh(): SessionAttendanceRefreshState {
  return { sessionId: null, status: "idle" };
}

export function isSessionAttendanceReady(
  state: SessionAttendanceRefreshState,
  selectedSessionId: string | null
) {
  return Boolean(
    selectedSessionId &&
    state.sessionId === selectedSessionId &&
    state.status === "ready"
  );
}

export function isCompleteScheduleRoster({
  studentsLoaded,
  studentsMayBePartial,
}: {
  studentsLoaded: boolean;
  studentsMayBePartial: boolean;
}) {
  return studentsLoaded && !studentsMayBePartial;
}

export async function runSessionAttendanceRefresh({
  isCurrent,
  onStateChange,
  refresh,
  sessionId,
}: {
  isCurrent: () => boolean;
  onStateChange: (state: SessionAttendanceRefreshState) => void;
  refresh: () => Promise<{ committed: boolean }>;
  sessionId: string;
}) {
  onStateChange(beginSessionAttendanceRefresh(sessionId));
  try {
    while (isCurrent()) {
      const result = await refresh();
      if (!isCurrent()) {
        return;
      }
      if (result.committed) {
        onStateChange({ sessionId, status: "ready" });
        return;
      }
    }
  } catch (error) {
    if (isCurrent()) {
      onStateChange({ sessionId, status: "error" });
    }
    throw error;
  }
}

export function createAttendanceToggleQueue(
  onPendingChange: (pendingIds: ReadonlySet<string>) => void
) {
  const tails = new Map<string, Promise<void>>();

  async function run(studentId: string, task: () => Promise<void>) {
    const previous = tails.get(studentId);
    const current = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // The next queued toggle must run after rollback completes, even when
          // the preceding request failed.
        }
      }
      await task();
    })();

    tails.set(studentId, current);
    onPendingChange(new Set(tails.keys()));
    try {
      await current;
    } finally {
      if (tails.get(studentId) === current) {
        tails.delete(studentId);
        onPendingChange(new Set(tails.keys()));
      }
    }
  }

  return { run };
}

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
    const currentDay = next.getDate();
    const targetMonth = next.getMonth() + direction;
    next.setDate(1);
    next.setMonth(targetMonth);
    const lastTargetDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(currentDay, lastTargetDay));
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
