"use client";

import { useMemo, type CSSProperties } from "react";
import { CalendarClock, Layers3 } from "lucide-react";

import { getProgramColor, getSessionFill } from "@/components/schedule/schedule-display";
import type { ClassSession, ClassTemplate, Program } from "@/types";
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
import styles from "./schedule.module.css";

export interface MonthScheduleViewProps {
  month: Date;
  sessions: ClassSession[];
  templates?: ClassTemplate[];
  /** Programs by id, so each class carries its program colour. */
  programById?: ReadonlyMap<string, Program>;
  selectedDate?: Date | string | null;
  today?: Date;
  maxVisibleEntries?: number;
  showHeader?: boolean;
  showTemplatePlaceholders?: boolean;
  isLoading?: boolean;
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

const EMPTY_PROGRAMS: ReadonlyMap<string, Program> = new Map();

export function MonthScheduleView({
  month,
  sessions,
  templates = [],
  programById = EMPTY_PROGRAMS,
  selectedDate,
  today = new Date(),
  maxVisibleEntries = 3,
  showHeader = true,
  showTemplatePlaceholders = false,
  isLoading = false,
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
    [month],
  );

  const sessionsByDate = useMemo(() => groupSessionsByDate(sessions), [sessions]);
  const templatesByDay = useMemo(() => groupTemplatesByDay(templates), [templates]);

  const monthlySessionCount = useMemo(
    () =>
      sessions.reduce((count, session) => count + (session.date.startsWith(monthKey) ? 1 : 0), 0),
    [monthKey, sessions],
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
          0,
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
    [maxVisibleEntries, month, monthDays, sessionsByDate, showTemplatePlaceholders, templatesByDay],
  );

  const monthlyTemplateGapCount = useMemo(() => {
    if (!showTemplatePlaceholders) {
      return 0;
    }

    return calendarDays.reduce(
      (count, day) => count + (day.inCurrentMonth ? day.templateCount : 0),
      0,
    );
  }, [calendarDays, showTemplatePlaceholders]);

  const monthIsEmpty =
    !isLoading &&
    calendarDays.every(
      (day) => !day.inCurrentMonth || day.visibleEntries.length + day.hiddenEntries.length === 0,
    );

  return (
    <div className={`${styles.month} ${className}`} data-month-schedule-view="true">
      {showHeader && (
        <div className={styles.monthHeader}>
          <div>
            <h2>{formatMonthLabel(month)}</h2>
            <p>{formatMonthRange(month)}</p>
          </div>

          <div className={styles.monthHeaderFacts}>
            <span>
              <CalendarClock aria-hidden="true" />
              {monthlySessionCount} scheduled
            </span>
            {showTemplatePlaceholders && monthlyTemplateGapCount > 0 && (
              <span>
                <Layers3 aria-hidden="true" />
                {monthlyTemplateGapCount} uncovered templates
              </span>
            )}
          </div>
        </div>
      )}

      {monthIsEmpty ? (
        <p className={styles.monthEmpty} role="note">
          No classes in {formatMonthLabel(month)}.
        </p>
      ) : null}

      {/* Day name headers */}
      <div className={styles.monthWeekdays} aria-hidden="true">
        {MONTH_DAY_NAMES.map((dayName) => (
          <div key={dayName}>
            <p>{dayName}</p>
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className={styles.monthGrid}>
        {calendarDays.map((day) => {
          const isToday = day.dateKey === todayKey;
          const isSelected = day.dateKey === selectedDateKey;
          const entryCount = day.visibleEntries.length + day.hiddenEntries.length;
          return (
            <div
              key={day.dateKey}
              data-month-schedule-day={day.dateKey}
              data-month-day-scope={day.inCurrentMonth ? "in-month" : "out-of-month"}
              data-month-day-today={isToday ? "true" : "false"}
              data-month-day-selected={isSelected ? "true" : "false"}
              data-month-day-empty={entryCount === 0 ? "true" : "false"}
              className={styles.monthDay}
            >
              {!isLoading && (
                <button
                  type="button"
                  onClick={() => onDayClick?.(day.date)}
                  aria-label={day.ariaLabel}
                  className={styles.monthDayButton}
                />
              )}

              {/* Day number and the one fact worth flagging */}
              <div className={styles.monthDayHead}>
                <span className={styles.monthDayNumber}>{day.date.getDate()}</span>
                <span className={styles.monthDayName}>{MONTH_DAY_NAMES[day.date.getDay()]}</span>
                {day.date.getDate() === 1 || !day.inCurrentMonth ? (
                  <span className={styles.monthDayMonth}>{day.monthLabel}</span>
                ) : null}
                {isToday && <span className={styles.monthTodayWord}>Today</span>}
                {day.conflictCount > 0 && (
                  <span className={styles.monthConflict}>
                    {day.conflictCount} overlap{day.conflictCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              {/* Entries */}
              <div className={styles.monthEntries}>
                {isLoading ? (
                  <div aria-hidden="true" className={styles.monthPending}>
                    <span />
                    <span />
                  </div>
                ) : null}

                {day.visibleEntries.map((entry) => {
                  if (entry.kind === "session") {
                    const program = entry.session.program_id
                      ? programById.get(entry.session.program_id)
                      : null;
                    const fill = getSessionFill(entry.session);
                    const conflicted = day.conflictingSessionIds.has(entry.session.id);
                    const canceled = entry.session.status === "canceled";
                    return (
                      <button
                        key={getEntryKey(entry)}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onEntryClick?.(entry);
                        }}
                        className={styles.chip}
                        data-conflict={conflicted ? "true" : undefined}
                        data-canceled={canceled ? "true" : undefined}
                        style={{ "--program-color": getProgramColor(program) } as CSSProperties}
                      >
                        <span className={styles.chipLine}>
                          <span className={styles.chipTime}>
                            {formatScheduleTime(entry.session.start_time)}
                          </span>
                          {canceled ? (
                            <span className={styles.chipFill}>Canceled</span>
                          ) : fill ? (
                            <span className={styles.chipFill}>{fill}</span>
                          ) : null}
                        </span>
                        <span className={styles.chipName}>{entry.session.name}</span>
                        {conflicted ? <span className={styles.chipConflict}>Overlaps</span> : null}
                      </button>
                    );
                  }

                  const program = entry.template.program_id
                    ? programById.get(entry.template.program_id)
                    : null;
                  return (
                    <div
                      key={getEntryKey(entry)}
                      aria-label={`Pending template slot: ${entry.template.name} at ${formatScheduleTime(entry.template.start_time)}`}
                      className={styles.chip}
                      data-template="true"
                      style={{ "--program-color": getProgramColor(program) } as CSSProperties}
                    >
                      <span className={styles.chipLine}>
                        <span className={styles.chipTime}>
                          {formatScheduleTime(entry.template.start_time)}
                        </span>
                        <span className={styles.chipFill}>Recurring</span>
                      </span>
                      <span className={styles.chipName}>{entry.template.name}</span>
                    </div>
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
                    className={styles.moreButton}
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
  );
}

export type { MonthScheduleEntry };
