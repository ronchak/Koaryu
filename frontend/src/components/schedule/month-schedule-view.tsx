"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { CalendarCheck, CalendarClock, ChevronDown, Layers3 } from "lucide-react";

import { getProgramColor, getSessionFill, pluralize } from "@/components/schedule/schedule-display";
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
  /** Every entry, in time order; the grid shows the first `maxVisibleEntries`. */
  entries: MonthScheduleEntry[];
  /** Known entries reserve their text geometry while the range materializes. */
  pendingEntries: MonthScheduleEntry[];
  hiddenEntries: MonthScheduleEntry[];
  sessionCount: number;
  templateCount: number;
  conflictingSessionIds: Set<string>;
  /** Before today in the business month, folded away in the agenda. */
  past: boolean;
  /** Classes on this day, or while loading the recurring ones it will have. */
  hasKnownClasses: boolean;
  /** All seven days of its week are in another month, so the grid skips the row. */
  rowOutOfMonth: boolean;
  /** The grid's last drawn row, which needs no bottom rule. */
  rowLast: boolean;
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
  maxVisibleEntries = 4,
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

  const isBusinessMonth = isDateInMonth(today, month);
  const outOfMonthRows = useMemo(() => {
    const rows = new Set<number>();
    for (let row = 0; row * 7 < monthDays.length; row += 1) {
      const week = monthDays.slice(row * 7, row * 7 + 7);
      if (week.every((date) => !isDateInMonth(date, month))) rows.add(row);
    }
    return rows;
  }, [month, monthDays]);
  const lastDrawnRow = useMemo(() => {
    let row = Math.ceil(monthDays.length / 7) - 1;
    while (row > 0 && outOfMonthRows.has(row)) row -= 1;
    return row;
  }, [monthDays.length, outOfMonthRows]);

  const calendarDays = useMemo<MonthScheduleDay[]>(
    () =>
      monthDays.map((date, index) => {
        const dateKey = toCalendarDateKey(date);
        const inCurrentMonth = isDateInMonth(date, month);
        const known = buildEntriesForDate({
          date,
          sessionsByDate,
          templatesByDay,
          showTemplatePlaceholders,
        });
        // Known classes reserve rows, but become actionable only once the range loads.
        const entries = isLoading ? [] : known;
        const hiddenEntries = entries.slice(maxVisibleEntries);
        const sessionCount = entries.reduce(
          (count, entry) => count + (entry.kind === "session" ? 1 : 0),
          0,
        );
        const daySessions = sessionsByDate.get(dateKey) ?? [];
        const conflictingSessionIds = getConflictingSessionIds(daySessions);
        const row = Math.floor(index / 7);

        return {
          date,
          dateKey,
          inCurrentMonth,
          entries,
          pendingEntries: isLoading ? known : [],
          hiddenEntries,
          sessionCount,
          templateCount: entries.length - sessionCount,
          conflictingSessionIds,
          past: isBusinessMonth && inCurrentMonth && dateKey < todayKey,
          hasKnownClasses: known.length > 0,
          rowOutOfMonth: outOfMonthRows.has(row),
          rowLast: row === lastDrawnRow,
          ariaLabel: `Open ${date.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}`,
          monthLabel: date.toLocaleDateString("en-US", { month: "short" }),
        };
      }),
    [
      isBusinessMonth,
      isLoading,
      lastDrawnRow,
      maxVisibleEntries,
      month,
      monthDays,
      outOfMonthRows,
      sessionsByDate,
      showTemplatePlaceholders,
      templatesByDay,
      todayKey,
    ],
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
    !isLoading && calendarDays.every((day) => !day.inCurrentMonth || day.entries.length === 0);

  // Today first: the agenda folds this month's earlier class days into one row.
  // While loading, recurring classes decide it, so today's row does not move.
  const [fold, setFold] = useState({ monthKey, open: false });
  if (fold.monthKey !== monthKey) setFold({ monthKey, open: false });
  const showPast = fold.monthKey === monthKey && fold.open;
  const pastClassDays = calendarDays.filter((day) => day.past && day.hasKnownClasses).length;
  const showEarlier = pastClassDays > 0;

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

      {showEarlier ? (
        <button
          type="button"
          className={styles.monthEarlier}
          aria-expanded={showPast}
          onClick={() => setFold({ monthKey, open: !showPast })}
        >
          {showPast
            ? "Hide earlier days"
            : isLoading
              ? "Earlier this month"
              : `Earlier this month (${pluralize(pastClassDays, "day")})`}
          <ChevronDown aria-hidden="true" />
        </button>
      ) : null}

      {/* Calendar grid */}
      <div className={styles.monthGrid} data-month-show-past={showPast ? "true" : undefined}>
        {calendarDays.map((day) => {
          const isToday = day.dateKey === todayKey;
          const isSelected = day.dateKey === selectedDateKey;
          return (
            <div
              key={day.dateKey}
              data-month-schedule-day={day.dateKey}
              data-month-day-scope={day.inCurrentMonth ? "in-month" : "out-of-month"}
              data-month-day-today={isToday ? "true" : "false"}
              data-month-day-selected={isSelected ? "true" : "false"}
              data-month-day-empty={day.hasKnownClasses ? "false" : "true"}
              data-month-day-past={day.past ? "true" : undefined}
              data-month-row-scope={day.rowOutOfMonth ? "out-of-month" : undefined}
              data-month-row-last={day.rowLast ? "true" : undefined}
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

              {/* Day number; each overlapping class says Overlaps itself */}
              <div className={styles.monthDayHead}>
                <span className={styles.monthDayNumber}>{day.date.getDate()}</span>
                <span className={styles.monthDayName}>{MONTH_DAY_NAMES[day.date.getDay()]}</span>
                {day.date.getDate() === 1 || !day.inCurrentMonth ? (
                  <span className={styles.monthDayMonth}>{day.monthLabel}</span>
                ) : null}
                {isToday && <span className={styles.monthTodayWord}>Today</span>}
              </div>

              {/* Entries */}
              <div className={styles.monthEntries}>
                {isLoading && day.pendingEntries.length === 0 ? (
                  <div aria-hidden="true" className={styles.monthPending}>
                    <span />
                    <span />
                  </div>
                ) : null}

                {day.pendingEntries.map((entry, index) => {
                  const details = entry.kind === "session" ? entry.session : entry.template;
                  const fill =
                    entry.kind === "session"
                      ? getSessionFill(entry.session)
                      : details.capacity
                        ? `0/${details.capacity}`
                        : null;
                  return (
                    <div
                      key={`pending-${getEntryKey(entry)}`}
                      aria-hidden="true"
                      className={`${styles.chip} ${styles.monthPendingEntry}`}
                      data-month-entry-overflow={index >= maxVisibleEntries ? "true" : undefined}
                    >
                      <span className={styles.chipTime}>
                        <span className={styles.monthPendingText}>
                          {formatScheduleTime(details.start_time)}
                        </span>
                      </span>
                      {fill ? (
                        <span className={`${styles.chipFill} ${styles.monthPendingText}`}>
                          {fill}
                        </span>
                      ) : null}
                      <span className={styles.chipBody}>
                        <span className={styles.chipName}>
                          <span className={styles.monthPendingText}>{details.name}</span>
                        </span>
                      </span>
                      {isToday ? (
                        <CalendarCheck
                          aria-hidden="true"
                          className={`${styles.chipAction} ${styles.monthPendingText}`}
                        />
                      ) : null}
                    </div>
                  );
                })}

                {day.pendingEntries.length > maxVisibleEntries ? (
                  <div
                    aria-hidden="true"
                    className={`${styles.moreButton} ${styles.monthPendingMore}`}
                  >
                    <span>+{day.pendingEntries.length - maxVisibleEntries} more</span>
                  </div>
                ) : null}

                {day.entries.map((entry, index) => {
                  const overflow = index >= maxVisibleEntries ? "true" : undefined;
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
                        data-month-entry-overflow={overflow}
                        style={{ "--program-color": getProgramColor(program) } as CSSProperties}
                      >
                        <span className={styles.chipTime}>
                          {formatScheduleTime(entry.session.start_time)}
                        </span>
                        {fill ? <span className={styles.chipFill}>{fill}</span> : null}
                        <span className={styles.chipBody}>
                          <span className={styles.chipName}>{entry.session.name}</span>
                          {canceled ? (
                            <span className={styles.chipStatus} data-status="canceled">
                              Canceled
                            </span>
                          ) : conflicted ? (
                            <span className={styles.chipStatus}>Overlaps</span>
                          ) : null}
                        </span>
                        {isToday ? (
                          <CalendarCheck aria-hidden="true" className={styles.chipAction} />
                        ) : null}
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
                      data-month-entry-overflow={overflow}
                      style={{ "--program-color": getProgramColor(program) } as CSSProperties}
                    >
                      <span className={styles.chipTime}>
                        {formatScheduleTime(entry.template.start_time)}
                      </span>
                      <span className={styles.chipFill}>Recurring</span>
                      <span className={styles.chipBody}>
                        <span className={styles.chipName}>{entry.template.name}</span>
                      </span>
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
