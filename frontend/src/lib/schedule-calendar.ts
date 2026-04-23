import type { ClassSession, ClassTemplate } from "@/types";

export const MONTH_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type MonthScheduleEntry =
  | {
      kind: "session";
      date: Date;
      dateKey: string;
      sortTime: string;
      session: ClassSession;
    }
  | {
      kind: "template";
      date: Date;
      dateKey: string;
      sortTime: string;
      template: ClassTemplate;
    };

export function createLocalDate(year: number, monthIndex: number, day: number) {
  return new Date(year, monthIndex, day, 12, 0, 0, 0);
}

export function parseCalendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return createLocalDate(year, month - 1, day);
}

export function toCalendarDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isSameCalendarDay(left: Date, right: Date) {
  return toCalendarDateKey(left) === toCalendarDateKey(right);
}

export function isDateInMonth(date: Date, month: Date) {
  return date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth();
}

export function formatMonthLabel(month: Date) {
  return month.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function formatMonthRange(month: Date) {
  const first = createLocalDate(month.getFullYear(), month.getMonth(), 1);
  const last = createLocalDate(month.getFullYear(), month.getMonth() + 1, 0);

  return `${first.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })} - ${last.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })}`;
}

export function formatScheduleTime(time: string) {
  const [rawHour = "0", rawMinute = "00"] = time.split(":");
  const hour = Number(rawHour);
  const minute = rawMinute.slice(0, 2);
  const ampm = hour >= 12 ? "PM" : "AM";
  const normalizedHour = hour % 12 || 12;
  return `${normalizedHour}:${minute} ${ampm}`;
}

export function buildMonthGrid(month: Date) {
  const firstOfMonth = createLocalDate(month.getFullYear(), month.getMonth(), 1);
  const gridStart = createLocalDate(
    firstOfMonth.getFullYear(),
    firstOfMonth.getMonth(),
    firstOfMonth.getDate() - firstOfMonth.getDay()
  );

  return Array.from({ length: 42 }, (_, index) =>
    createLocalDate(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index)
  );
}

export function groupSessionsByDate(sessions: ClassSession[]) {
  const grouped = new Map<string, ClassSession[]>();

  sessions.forEach((session) => {
    const dateSessions = grouped.get(session.date) ?? [];
    dateSessions.push(session);
    grouped.set(session.date, dateSessions);
  });

  grouped.forEach((dateSessions, key) => {
    grouped.set(
      key,
      [...dateSessions].sort((left, right) => left.start_time.localeCompare(right.start_time))
    );
  });

  return grouped;
}

export function groupTemplatesByDay(templates: ClassTemplate[]) {
  const grouped = new Map<number, ClassTemplate[]>();

  templates
    .filter((template) => template.is_active)
    .forEach((template) => {
      const dayTemplates = grouped.get(template.day_of_week) ?? [];
      dayTemplates.push(template);
      grouped.set(template.day_of_week, dayTemplates);
    });

  grouped.forEach((dayTemplates, key) => {
    grouped.set(
      key,
      [...dayTemplates].sort((left, right) => left.start_time.localeCompare(right.start_time))
    );
  });

  return grouped;
}

function templateAppliesToDate(template: ClassTemplate, dateKey: string) {
  if (!template.is_active) {
    return false;
  }

  if (template.start_date > dateKey) {
    return false;
  }

  if (template.end_date && template.end_date < dateKey) {
    return false;
  }

  return true;
}

function toMinutes(time: string) {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function getConflictingSessionIds(sessions: ClassSession[]) {
  const conflictingIds = new Set<string>();
  const sortedSessions = [...sessions].sort((left, right) => left.start_time.localeCompare(right.start_time));

  for (let index = 0; index < sortedSessions.length; index += 1) {
    const current = sortedSessions[index];
    const currentStart = toMinutes(current.start_time);
    const currentEnd = toMinutes(current.end_time);

    for (let nextIndex = index + 1; nextIndex < sortedSessions.length; nextIndex += 1) {
      const next = sortedSessions[nextIndex];
      const nextStart = toMinutes(next.start_time);

      if (nextStart >= currentEnd) {
        break;
      }

      if (currentStart < toMinutes(next.end_time) && nextStart < currentEnd) {
        conflictingIds.add(current.id);
        conflictingIds.add(next.id);
      }
    }
  }

  return conflictingIds;
}

export function getSessionConflictCount(sessions: ClassSession[]) {
  return getConflictingSessionIds(sessions).size;
}

function sessionMatchesTemplate(session: ClassSession, template: ClassTemplate) {
  if (session.template_id && session.template_id === template.id) {
    return true;
  }

  return (
    session.name === template.name &&
    session.start_time === template.start_time &&
    session.end_time === template.end_time
  );
}

export function buildEntriesForDate(params: {
  date: Date;
  sessionsByDate: Map<string, ClassSession[]>;
  templatesByDay: Map<number, ClassTemplate[]>;
  showTemplatePlaceholders?: boolean;
}) {
  const { date, sessionsByDate, templatesByDay, showTemplatePlaceholders = false } = params;
  const dateKey = toCalendarDateKey(date);
  const daySessions = sessionsByDate.get(dateKey) ?? [];
  const entries: MonthScheduleEntry[] = daySessions.map((session) => ({
    kind: "session",
    date,
    dateKey,
    sortTime: session.start_time,
    session,
  }));

  if (showTemplatePlaceholders) {
    const dayTemplates = templatesByDay.get(date.getDay()) ?? [];

    dayTemplates.forEach((template) => {
      if (!templateAppliesToDate(template, dateKey)) {
        return;
      }

      const hasGeneratedSession = daySessions.some((session) => sessionMatchesTemplate(session, template));

      if (!hasGeneratedSession) {
        entries.push({
          kind: "template",
          date,
          dateKey,
          sortTime: template.start_time,
          template,
        });
      }
    });
  }

  return entries.sort((left, right) => left.sortTime.localeCompare(right.sortTime));
}
