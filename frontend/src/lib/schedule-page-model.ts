import type { AttendanceRecord, ClassSession, ClassTemplate, Student } from "@/types";
import {
  buildEntriesForDate,
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

export type ScheduleTimeLayoutOptions<T extends ScheduleTimeItem> = {
  /** Reserve a drawn footprint without changing class times or overlap semantics. */
  getOccupiedInterval?: (
    block: Pick<ScheduleTimeBlock<T>, "item" | "startMinute" | "endMinute">,
  ) => { startMinute: number; endMinute: number };
};

export const DEFAULT_SCHEDULE_PAGE_VIEW: SchedulePageView = "month";

/** Week and Day hour height; Day on a phone-width sheet draws 56px hours (set in CSS). */
export const SCHEDULE_CANVAS_PIXELS_PER_HOUR = 48;

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

const SCHEDULE_CANVAS_MIN_SPAN = 6 * 60;

/**
 * The hours worth drawing: from the hour the first class starts to the hour the
 * last one ends, at least six hours. Nothing in view keeps a 9-to-9 studio day.
 */
export function getScheduleCanvasRange(items: ReadonlyArray<ScheduleTimeItem>) {
  if (items.length === 0) {
    return { startMinute: 9 * 60, endMinute: 21 * 60 };
  }
  const earliest = Math.min(...items.map((item) => scheduleTimeToMinute(item.start_time)));
  const latest = Math.max(
    ...items.map((item) =>
      Math.max(scheduleTimeToMinute(item.start_time) + 15, scheduleTimeToMinute(item.end_time)),
    ),
  );
  let startMinute = Math.floor(earliest / 60) * 60;
  let endMinute = Math.min(24 * 60, Math.ceil(latest / 60) * 60);
  if (endMinute - startMinute < SCHEDULE_CANVAS_MIN_SPAN) {
    endMinute = Math.min(24 * 60, startMinute + SCHEDULE_CANVAS_MIN_SPAN);
    startMinute = Math.max(0, endMinute - SCHEDULE_CANVAS_MIN_SPAN);
  }
  return { startMinute, endMinute };
}

export function layoutScheduleTimeItems<T extends ScheduleTimeItem>(
  items: ReadonlyArray<T>,
  options: ScheduleTimeLayoutOptions<T> = {},
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

  // Actual time groups determine overlap flags, independently of drawn lanes.
  let groupStart = 0;
  while (groupStart < sorted.length) {
    let groupEnd = groupStart + 1;
    let latestEnd = sorted[groupStart].endMinute;
    while (groupEnd < sorted.length && sorted[groupEnd].startMinute < latestEnd) {
      latestEnd = Math.max(latestEnd, sorted[groupEnd].endMinute);
      groupEnd += 1;
    }

    for (let index = groupStart; index < groupEnd; index += 1) {
      sorted[index].overlaps = groupEnd - groupStart > 1;
    }
    groupStart = groupEnd;
  }

  const occupied = sorted
    .map((block, order) => ({
      block,
      order,
      ...(options.getOccupiedInterval?.(block) ?? block),
    }))
    .sort(
      (a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.order - b.order,
    );

  groupStart = 0;
  while (groupStart < occupied.length) {
    let groupEnd = groupStart + 1;
    let latestEnd = occupied[groupStart].endMinute;
    while (groupEnd < occupied.length && occupied[groupEnd].startMinute < latestEnd) {
      latestEnd = Math.max(latestEnd, occupied[groupEnd].endMinute);
      groupEnd += 1;
    }

    const laneEnds: number[] = [];
    for (let index = groupStart; index < groupEnd; index += 1) {
      const interval = occupied[index];
      const block = interval.block;
      const availableLane = laneEnds.findIndex((endMinute) => endMinute <= interval.startMinute);
      block.lane = availableLane === -1 ? laneEnds.length : availableLane;
      laneEnds[block.lane] = interval.endMinute;
    }
    for (let index = groupStart; index < groupEnd; index += 1) {
      occupied[index].block.laneCount = laneEnds.length;
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

/**
 * The window the page loads for a date: the month grid holding it. The grid is
 * week-aligned, so it also holds the date's week and covers every view of it.
 */
export function getScheduleLoadRange(currentDate: Date) {
  return getVisibleScheduleRange(currentDate, "month");
}

/**
 * The loaded window stays while it still covers what is in view, so Day and
 * Week steps and view switches inside it cost no request, even across a month
 * boundary. Only a view that reaches outside it loads the grid around its date.
 */
export function resolveScheduleLoadRange(
  previous: { start: string; end: string } | null,
  currentDate: Date,
  view: SchedulePageView,
) {
  const visible = getVisibleScheduleRange(currentDate, view);
  if (previous && visible.start >= previous.start && visible.end <= previous.end) {
    return previous;
  }
  return getScheduleLoadRange(currentDate);
}

/**
 * Recurring occurrences the calendar shows as placeholders because no session
 * exists for them yet. Generated sessions, including cancellations, already
 * occupy their slot. Zero means a read of the range is complete on its own.
 */
export function countUnmaterializedRecurringSlots({
  range,
  sessions,
  templates,
}: {
  range: { start: string; end: string };
  sessions: ClassSession[];
  templates: ClassTemplate[];
}) {
  const templatesByDay = groupTemplatesByDay(templates);
  if (templatesByDay.size === 0) {
    return 0;
  }
  const sessionsByDate = groupSessionsByDate(
    sessions.filter((session) => session.date >= range.start && session.date <= range.end),
  );
  let recurringSlots = 0;
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
  return recurringSlots;
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
  const scheduled = sessions.filter(
    (session) => session.date >= range.start && session.date <= range.end,
  ).length;
  return {
    scheduled,
    recurringSlots: countUnmaterializedRecurringSlots({ range, sessions, templates }),
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
