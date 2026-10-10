import type { AttendanceRecord, ClassSession, ClassTemplate, Student } from "@/types";
import {
  buildEntriesForDate,
  getConflictingSessionIds,
  groupSessionsByDate,
  groupTemplatesByDay,
  parseCalendarDate,
} from "./schedule-calendar.ts";
import { withCurrentMinorStatus } from "./student-age.ts";

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

const FOCUSED_CANVAS_MIN_SPAN = 6 * 60;
const FOCUSED_CANVAS_TARGET_HEIGHT = 960;
const FOCUSED_CANVAS_MAX_HOUR_HEIGHT = 112;

/**
 * The hours worth drawing: an hour either side of the classes in view (at least
 * six hours), and taller hours when the span is short so each class has room for
 * its name, time and fill. Empty ranges keep the default studio day.
 */
export function getFocusedScheduleCanvas(items: ReadonlyArray<ScheduleTimeItem>) {
  if (items.length === 0) {
    return { ...getScheduleTimeCanvasBounds(items), hourHeight: SCHEDULE_CANVAS_PIXELS_PER_HOUR };
  }
  const earliest = Math.min(...items.map((item) => scheduleTimeToMinute(item.start_time)));
  const latest = Math.max(
    ...items.map((item) =>
      Math.max(scheduleTimeToMinute(item.start_time) + 15, scheduleTimeToMinute(item.end_time)),
    ),
  );
  let startMinute = Math.max(0, Math.floor(earliest / 60) * 60 - 60);
  let endMinute = Math.min(24 * 60, Math.ceil(latest / 60) * 60 + 60);
  if (endMinute - startMinute < FOCUSED_CANVAS_MIN_SPAN) {
    endMinute = Math.min(24 * 60, startMinute + FOCUSED_CANVAS_MIN_SPAN);
    startMinute = Math.max(0, endMinute - FOCUSED_CANVAS_MIN_SPAN);
  }
  const hours = (endMinute - startMinute) / 60;
  const hourHeight = Math.round(
    Math.min(
      FOCUSED_CANVAS_MAX_HOUR_HEIGHT,
      Math.max(SCHEDULE_CANVAS_PIXELS_PER_HOUR, FOCUSED_CANVAS_TARGET_HEIGHT / hours),
    ),
  );
  return { startMinute, endMinute, hourHeight };
}

export function layoutScheduleTimeItems<T extends ScheduleTimeItem>(
  items: ReadonlyArray<T>,
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
    .sort(
      (a, b) =>
        a.startMinute - b.startMinute ||
        a.endMinute - b.endMinute ||
        a.item.id.localeCompare(b.item.id),
    );

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
  selectedSessionId: string | null,
) {
  return Boolean(
    selectedSessionId && state.sessionId === selectedSessionId && state.status === "ready",
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
  onPendingChange: (pendingIds: ReadonlySet<string>) => void,
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

export function getVisibleScheduleSummary({
  currentDate,
  view,
  sessions,
  templates,
}: {
  currentDate: Date;
  view: SchedulePageView;
  sessions: ClassSession[];
  templates: ClassTemplate[];
}) {
  const range = getVisibleScheduleRange(currentDate, view);
  const visibleSessions = sessions.filter(
    (session) => session.date >= range.start && session.date <= range.end,
  );
  const sessionsByDate = groupSessionsByDate(visibleSessions);
  const templatesByDay = groupTemplatesByDay(templates);
  let recurringSlots = 0;

  // Count the same unmaterialized recurring occurrences the calendar displays.
  // Generated sessions, including cancellations, already occupy their slot.
  for (
    const date = parseCalendarDate(range.start);
    formatScheduleDateKey(date) <= range.end;
    date.setDate(date.getDate() + 1)
  ) {
    recurringSlots += buildEntriesForDate({
      date,
      sessionsByDate,
      templatesByDay,
      showTemplatePlaceholders: true,
    }).filter((entry) => entry.kind === "template").length;
  }

  return { scheduled: visibleSessions.length, recurringSlots };
}

export type ScheduleRangeFigures = {
  scheduled: number;
  recurringSlots: number;
  /** Check-ins recorded on classes in view that were not canceled. */
  checkIns: number;
  /** Seats on classes in view that have a capacity and were not canceled. */
  seats: number;
  /** Unfilled seats on classes from the business date onward. */
  openSeats: number;
  upcomingWithCapacity: number;
  /** Classes in view whose times overlap another class on the same day. */
  overlaps: number;
};

/** The headline figures for the visible range, using the same sessions the calendar draws. */
export function getScheduleRangeFigures({
  businessDate,
  currentDate,
  view,
  sessions,
  templates,
}: {
  businessDate: string;
  currentDate: Date;
  view: SchedulePageView;
  sessions: ClassSession[];
  templates: ClassTemplate[];
}): ScheduleRangeFigures {
  const { scheduled, recurringSlots } = getVisibleScheduleSummary({
    currentDate,
    view,
    sessions,
    templates,
  });
  const range = getVisibleScheduleRange(currentDate, view);
  const visibleSessions = sessions.filter(
    (session) => session.date >= range.start && session.date <= range.end,
  );
  let checkIns = 0;
  let seats = 0;
  let openSeats = 0;
  let upcomingWithCapacity = 0;
  for (const session of visibleSessions) {
    if (session.status === "canceled") continue;
    const attended = Math.max(0, session.attendance_count || 0);
    checkIns += attended;
    if (!session.capacity) continue;
    seats += session.capacity;
    if (session.date >= businessDate) {
      upcomingWithCapacity += 1;
      openSeats += Math.max(0, session.capacity - attended);
    }
  }
  let overlaps = 0;
  for (const daySessions of groupSessionsByDate(visibleSessions).values()) {
    overlaps += getConflictingSessionIds(daySessions).size;
  }
  return {
    scheduled,
    recurringSlots,
    checkIns,
    seats,
    openSeats,
    upcomingWithCapacity,
    overlaps,
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

export function getActiveScheduleStudents(students: Student[], businessDate: string) {
  return students
    .filter((student) => student.status === "active" || student.status === "trialing")
    .map((student) => withCurrentMinorStatus(student, businessDate));
}

export function getScheduleSessionAttendance(
  attendance: AttendanceRecord[],
  session: Pick<ClassSession, "id"> | null,
) {
  if (!session) {
    return [];
  }

  return attendance.filter((record) => record.session_id === session.id);
}
