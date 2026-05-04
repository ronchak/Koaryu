"use client";

import { useMemo } from "react";
import { CalendarClock, Layers3, Users } from "lucide-react";

import type { ClassSession, ClassTemplate } from "@/types";
import {
  MONTH_DAY_NAMES,
  buildEntriesForDate,
  buildMonthGrid,
  formatMonthLabel,
  formatMonthRange,
  formatScheduleTime,
  getConflictingSessionIds,
  groupSessionsByDate,
  groupTemplatesByDay,
  isDateInMonth,
  parseCalendarDate,
  toCalendarDateKey,
  type MonthScheduleEntry,
} from "@/lib/schedule-calendar";

export interface MonthScheduleViewProps {
  month: Date;
  sessions: ClassSession[];
  templates?: ClassTemplate[];
  selectedDate?: Date | string | null;
  today?: Date;
  maxVisibleEntries?: number;
  showHeader?: boolean;
  showTemplatePlaceholders?: boolean;
  className?: string;
  onDayClick?: (date: Date) => void;
  onEntryClick?: (entry: MonthScheduleEntry) => void;
  onMoreClick?: (date: Date, hiddenEntries: MonthScheduleEntry[]) => void;
}

function getSelectedDateKey(selectedDate?: Date | string | null) {
  if (!selectedDate) {
    return null;
  }

  return typeof selectedDate === "string"
    ? toCalendarDateKey(parseCalendarDate(selectedDate))
    : toCalendarDateKey(selectedDate);
}

function getEntryKey(entry: MonthScheduleEntry) {
  return entry.kind === "session"
    ? `session-${entry.session.id}`
    : `template-${entry.template.id}-${entry.dateKey}`;
}

function getSessionMeta(session: ClassSession) {
  if (session.capacity && session.attendance_count > 0) {
    return `${session.attendance_count}/${session.capacity}`;
  }

  if (session.capacity) {
    return `Cap ${session.capacity}`;
  }

  if (session.attendance_count > 0) {
    return `${session.attendance_count} in`;
  }

  return session.status.replace("_", " ");
}

interface MonthScheduleDay {
  date: Date;
  dateKey: string;
  inCurrentMonth: boolean;
  visibleEntries: MonthScheduleEntry[];
  hiddenEntries: MonthScheduleEntry[];
  sessionCount: number;
  templateCount: number;
  conflictingSessionIds: Set<string>;
  conflictCount: number;
  ariaLabel: string;
  monthLabel: string;
}

export function MonthScheduleView({
  month,
  sessions,
  templates = [],
  selectedDate,
  today = new Date(),
  maxVisibleEntries = 3,
  showHeader = true,
  showTemplatePlaceholders = false,
  className = "",
  onDayClick,
  onEntryClick,
  onMoreClick,
}: MonthScheduleViewProps) {
  const monthDays = useMemo(() => buildMonthGrid(month), [month]);
  const todayKey = useMemo(() => toCalendarDateKey(today), [today]);
  const selectedDateKey = useMemo(() => getSelectedDateKey(selectedDate), [selectedDate]);
  const monthKey = useMemo(
    () => `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`,
    [month]
  );

  const sessionsByDate = useMemo(() => groupSessionsByDate(sessions), [sessions]);
  const templatesByDay = useMemo(() => groupTemplatesByDay(templates), [templates]);

  const monthlySessionCount = useMemo(
    () => sessions.reduce((count, session) => count + (session.date.startsWith(monthKey) ? 1 : 0), 0),
    [monthKey, sessions]
  );

  const calendarDays = useMemo<MonthScheduleDay[]>(
    () =>
      monthDays.map((date) => {
        const dateKey = toCalendarDateKey(date);
        const entries = buildEntriesForDate({
          date,
          sessionsByDate,
          templatesByDay,
          showTemplatePlaceholders,
        });
        const visibleEntries = entries.slice(0, maxVisibleEntries);
        const hiddenEntries = entries.slice(maxVisibleEntries);
        const sessionCount = entries.reduce(
          (count, entry) => count + (entry.kind === "session" ? 1 : 0),
          0
        );
        const daySessions = sessionsByDate.get(dateKey) ?? [];
        const conflictingSessionIds = getConflictingSessionIds(daySessions);

        return {
          date,
          dateKey,
          inCurrentMonth: isDateInMonth(date, month),
          visibleEntries,
          hiddenEntries,
          sessionCount,
          templateCount: entries.length - sessionCount,
          conflictingSessionIds,
          conflictCount: conflictingSessionIds.size,
          ariaLabel: `Open ${date.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}`,
          monthLabel: date.toLocaleDateString("en-US", { month: "short" }),
        };
      }),
    [maxVisibleEntries, month, monthDays, sessionsByDate, showTemplatePlaceholders, templatesByDay]
  );

  const monthlyTemplateGapCount = useMemo(() => {
    if (!showTemplatePlaceholders) {
      return 0;
    }

    return calendarDays.reduce(
      (count, day) => count + (day.inCurrentMonth ? day.templateCount : 0),
      0
    );
  }, [calendarDays, showTemplatePlaceholders]);

  return (
    <div className={`border border-border bg-surface ${className}`}>
      {showHeader && (
        <div className="flex flex-col gap-3 border-b border-border px-4 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Month View</p>
            <h2 className="mt-1 text-lg font-semibold text-text-primary">{formatMonthLabel(month)}</h2>
            <p className="mt-1 text-xs text-text-secondary">{formatMonthRange(month)}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
            <span className="inline-flex items-center gap-1.5 border border-border bg-surface-raised px-2.5 py-1">
              <CalendarClock className="h-3.5 w-3.5" />
              {monthlySessionCount} scheduled
            </span>
            {showTemplatePlaceholders && monthlyTemplateGapCount > 0 && (
              <span className="inline-flex items-center gap-1.5 border border-border bg-surface-raised px-2.5 py-1">
                <Layers3 className="h-3.5 w-3.5" />
                {monthlyTemplateGapCount} uncovered templates
              </span>
            )}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <div className="min-w-[980px]">
          {/* Day name headers */}
          <div className="grid grid-cols-7 border-b border-border bg-surface-raised/60">
            {MONTH_DAY_NAMES.map((dayName) => (
              <div key={dayName} className="border-r border-border px-3 py-2 last:border-r-0">
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">{dayName}</p>
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="grid grid-cols-7">
            {calendarDays.map((day) => {
              const isToday = day.dateKey === todayKey;
              const isSelected = day.dateKey === selectedDateKey;
              return (
                <div
                  key={day.dateKey}
                  className={`group relative flex min-h-[156px] flex-col border-r border-b border-border px-2.5 py-2 text-left transition-colors last:border-r-0 hover:bg-surface-raised/50 ${
                    day.inCurrentMonth ? "bg-surface" : "bg-bg text-text-secondary"
                  } ${isSelected ? "ring-1 ring-inset ring-accent" : ""} ${
                    isToday ? "bg-accent/[0.04]" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onDayClick?.(day.date)}
                    aria-label={day.ariaLabel}
                    className="absolute inset-0"
                  />

                  {/* Day number and metadata */}
                  <div className="relative z-10 mb-2 flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex h-7 min-w-7 items-center justify-center px-2 text-sm font-semibold ${
                          isToday
                            ? "bg-accent text-accent-contrast"
                            : day.inCurrentMonth
                            ? "bg-surface-raised text-text-primary"
                            : "bg-transparent text-muted"
                        }`}
                      >
                        {day.date.getDate()}
                      </span>
                      <div className="flex flex-col">
                        <span className={`text-[10px] uppercase tracking-widest ${day.inCurrentMonth ? "text-muted" : "text-muted"}`}>
                          {day.monthLabel}
                        </span>
                        {isToday && <span className="text-[10px] font-medium text-accent">Today</span>}
                      </div>
                    </div>

                    {(day.sessionCount > 0 || day.templateCount > 0) && (
                      <div className="flex flex-col items-end gap-1">
                        {day.sessionCount > 0 && (
                          <span className="bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-text-primary">
                            {day.sessionCount} {day.sessionCount === 1 ? "class" : "classes"}
                          </span>
                        )}
                        {day.conflictCount > 0 && (
                          <span className="border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
                            {day.conflictCount} conflict{day.conflictCount === 1 ? "" : "s"}
                          </span>
                        )}
                        {day.templateCount > 0 && (
                          <span className="border border-dashed border-border px-2 py-0.5 text-[10px] text-muted">
                            {day.templateCount} pending
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Entries */}
                  <div className="relative z-10 flex flex-1 flex-col gap-1.5">
                    {day.visibleEntries.length === 0 && (
                      <div className="mt-2 border border-dashed border-border/80 px-2 py-2 text-[11px] text-muted">
                        No scheduled classes
                      </div>
                    )}

                    {day.visibleEntries.map((entry) => {
                      if (entry.kind === "session") {
                        return (
                          <button
                            key={getEntryKey(entry)}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onEntryClick?.(entry);
                            }}
                            className={`flex items-start gap-2 border px-2 py-1.5 text-left hover:bg-surface-hover transition-colors ${
                              day.conflictingSessionIds.has(entry.session.id)
                                ? "border-danger/30 bg-danger/5 hover:border-danger/50"
                                : "border-border bg-surface-raised hover:border-[color:var(--accent)]/40"
                            }`}
                          >
                            <div className="min-w-[50px] text-[10px] font-medium text-muted">
                              {formatScheduleTime(entry.session.start_time)}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[11px] font-medium text-text-primary">{entry.session.name}</p>
                              <div className="mt-1 flex items-center gap-2 text-[10px] text-text-secondary">
                                <span className="capitalize">{getSessionMeta(entry.session)}</span>
                                {day.conflictingSessionIds.has(entry.session.id) && (
                                  <span className="text-danger">Overlaps</span>
                                )}
                                {entry.session.capacity && (
                                  <span className="inline-flex items-center gap-1">
                                    <Users className="h-3 w-3" />
                                    {entry.session.capacity}
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      }

                      return (
                        <button
                          key={getEntryKey(entry)}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onEntryClick?.(entry);
                          }}
                          className="flex items-start gap-2 border border-dashed border-border bg-transparent px-2 py-1.5 text-left opacity-80 hover:border-[color:var(--accent)]/40 hover:bg-surface-raised/40 transition-colors"
                        >
                          <div className="min-w-[50px] text-[10px] font-medium text-muted">
                            {formatScheduleTime(entry.template.start_time)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[11px] text-text-secondary">{entry.template.name}</p>
                            <p className="mt-1 text-[10px] uppercase tracking-widest text-muted">Template slot</p>
                          </div>
                        </button>
                      );
                    })}

                    {day.hiddenEntries.length > 0 && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (onMoreClick) {
                            onMoreClick(day.date, day.hiddenEntries);
                            return;
                          }

                          onDayClick?.(day.date);
                        }}
                        className="mt-auto border border-border px-2 py-1.5 text-left text-[11px] font-medium text-accent hover:bg-accent/10 transition-colors"
                      >
                        +{day.hiddenEntries.length} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export type { MonthScheduleEntry };
