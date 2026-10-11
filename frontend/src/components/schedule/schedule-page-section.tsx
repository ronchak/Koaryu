"use client";

import { useMemo, type CSSProperties } from "react";
import { CalendarCheck, CalendarPlus, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";

import { Header } from "@/components/header";
import { MonthScheduleView } from "@/components/schedule/month-schedule-view";
import {
  formatClockTime,
  getProgramColor,
  getSessionFill,
  getSessionFillRatio,
  pluralize,
} from "@/components/schedule/schedule-display";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import {
  CalmState,
  HorizonPage,
  HorizonPanel,
  PlainHorizonStats as HorizonStats,
  ToneTag,
  type PlainHorizonStat as HorizonStat,
} from "@/components/schedule/horizon-parts";
import { SlidingSegmentedControl } from "@/components/ui/sliding-segmented-control";
import {
  buildEntriesForDate,
  getConflictingSessionIds,
  groupSessionsByDate,
  groupTemplatesByDay,
  parseCalendarDate,
} from "@/lib/schedule-calendar";
import {
  formatScheduleDateKey,
  getScheduleRangeFigures,
  getFocusedScheduleCanvas,
  getScheduleWeekDates,
  getVisibleScheduleRange,
  layoutScheduleTimeItems,
  type SchedulePageView,
} from "@/lib/schedule-page-model";
import type { ClassSession, ClassTemplate, Program } from "@/types";
import styles from "./schedule.module.css";

interface SchedulePageSectionProps {
  businessDate: string;
  canManageSchedule: boolean;
  currentDate: Date;
  view: SchedulePageView;
  programFilter: string;
  sessions: ClassSession[];
  templates: ClassTemplate[];
  programs: Program[];
  scheduleLoadError: string | null;
  hasLoadedRange: boolean;
  isRefreshingRange: boolean;
  actionMessage: string | null;
  /** Why a linked class did not open, shown while its range is in view. */
  routeTargetNotice?: string | null;
  onDismissRouteTargetNotice?: () => void;
  onRetryRange: () => void;
  onNavigate: (direction: number) => void;
  onJumpToToday: () => void;
  onViewChange: (view: SchedulePageView) => void;
  onProgramFilterChange: (programId: string) => void;
  onDismissScheduleLoadError: () => void;
  onDismissActionMessage: () => void;
  onSelectDate: (date: Date) => void;
  onOpenSession: (session: ClassSession) => void;
  onOpenAddClass: () => void;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCHEDULE_VIEWS: SchedulePageView[] = ["month", "week", "day"];
const DATE_RANGE_SEPARATOR = String.fromCharCode(8211);
const WEEK_CANVAS_MIN_WIDTH = 1040;
const WEEK_TIME_COLUMN_WIDTH = 72;
const WEEK_DAY_COUNT = 7;
const SESSION_LANE_MIN_WIDTH = 48;

type TimeCanvasEntry = {
  id: string;
  kind: "session" | "template";
  start_time: string;
  end_time: string;
  session?: ClassSession;
  template?: ClassTemplate;
};

function isPointWithinTimeCanvasFootprint(
  footprint: Pick<DOMRect, "bottom" | "left" | "right" | "top">,
  clientX: number,
  clientY: number,
) {
  return (
    clientY >= footprint.top &&
    clientY < footprint.bottom &&
    clientX >= footprint.left &&
    clientX < footprint.right
  );
}

const formatTime = formatClockTime;

function getSessionButtonLabel(session: ClassSession) {
  return `Open ${session.name} at ${formatTime(session.start_time)}`;
}

function formatCanvasHour(minute: number) {
  const hour = Math.floor(minute / 60) % 24;
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return `${hour > 12 ? hour - 12 : hour} ${hour >= 12 ? "PM" : "AM"}`;
}

function formatLongDate(date: Date) {
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function SchedulePageSection({
  businessDate,
  canManageSchedule,
  currentDate,
  view,
  programFilter,
  sessions,
  templates,
  programs,
  scheduleLoadError,
  hasLoadedRange,
  isRefreshingRange,
  actionMessage,
  routeTargetNotice = null,
  onDismissRouteTargetNotice,
  onNavigate,
  onRetryRange,
  onJumpToToday,
  onViewChange,
  onProgramFilterChange,
  onDismissScheduleLoadError,
  onDismissActionMessage,
  onSelectDate,
  onOpenSession,
  onOpenAddClass,
}: SchedulePageSectionProps) {
  const today = businessDate;
  const todayDate = useMemo(() => parseCalendarDate(businessDate), [businessDate]);
  const weekDates = useMemo(() => getScheduleWeekDates(currentDate), [currentDate]);
  const activePrograms = useMemo(
    () => programs.filter((program) => !program.archived_at),
    [programs],
  );
  const programById = useMemo(
    () => new Map(programs.map((program) => [program.id, program])),
    [programs],
  );
  const filteredSessions = useMemo(
    () =>
      programFilter ? sessions.filter((session) => session.program_id === programFilter) : sessions,
    [programFilter, sessions],
  );
  const filteredTemplates = useMemo(
    () =>
      programFilter
        ? templates.filter((template) => template.program_id === programFilter)
        : templates,
    [programFilter, templates],
  );
  const figures = useMemo(
    () =>
      getScheduleRangeFigures({
        businessDate,
        currentDate,
        view,
        sessions: filteredSessions,
        templates: filteredTemplates,
      }),
    [businessDate, currentDate, view, filteredSessions, filteredTemplates],
  );
  const visibleRange = useMemo(
    () => getVisibleScheduleRange(currentDate, view),
    [currentDate, view],
  );
  // Today's classes are only known when the loaded range covers the business date.
  const todayInView = today >= visibleRange.start && today <= visibleRange.end;
  const todayKnown = todayInView && hasLoadedRange;

  const sessionsByDate = useMemo(() => groupSessionsByDate(filteredSessions), [filteredSessions]);
  const templatesByDay = useMemo(() => groupTemplatesByDay(filteredTemplates), [filteredTemplates]);
  const todaySessions = useMemo(() => sessionsByDate.get(today) ?? [], [sessionsByDate, today]);
  const todayConflicts = useMemo(() => getConflictingSessionIds(todaySessions), [todaySessions]);
  const todayCheckIns = todaySessions.reduce(
    (total, session) =>
      total + (session.status === "canceled" ? 0 : Math.max(0, session.attendance_count || 0)),
    0,
  );
  // The Day view of today already is today's list; elsewhere today gets its own panel.
  const showTodayPanel =
    todayInView && view !== "day" && (!hasLoadedRange || todaySessions.length > 0);

  const entriesByDate = useMemo(() => {
    const grouped: Record<string, TimeCanvasEntry[]> = {};
    const dates = view === "day" ? [currentDate] : weekDates;
    dates.forEach((date) => {
      const key = formatScheduleDateKey(date);
      grouped[key] = buildEntriesForDate({
        date,
        sessionsByDate,
        templatesByDay,
        showTemplatePlaceholders: true,
      }).map((entry) =>
        entry.kind === "session"
          ? {
              id: entry.session.id,
              kind: entry.kind,
              start_time: entry.session.start_time,
              end_time: entry.session.end_time,
              session: entry.session,
            }
          : {
              id: entry.template.id,
              kind: entry.kind,
              start_time: entry.template.start_time,
              end_time: entry.template.end_time,
              template: entry.template,
            },
      );
    });
    return grouped;
  }, [currentDate, sessionsByDate, templatesByDay, view, weekDates]);
  const layoutsByDate = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(entriesByDate).map(([key, entries]) => [
          key,
          layoutScheduleTimeItems(entries),
        ]),
      ),
    [entriesByDate],
  );
  const canvasBounds = useMemo(
    () => getFocusedScheduleCanvas(Object.values(entriesByDate).flat()),
    [entriesByDate],
  );
  const canvasHourMarks = useMemo(
    () =>
      Array.from(
        { length: Math.floor((canvasBounds.endMinute - canvasBounds.startMinute) / 60) + 1 },
        (_, index) => canvasBounds.startMinute + index * 60,
      ),
    [canvasBounds.endMinute, canvasBounds.startMinute],
  );
  const canvasHeight =
    ((canvasBounds.endMinute - canvasBounds.startMinute) / 60) * canvasBounds.hourHeight;
  const peakWeekLaneCount = useMemo(
    () =>
      weekDates.reduce((peak, date) => {
        const key = formatScheduleDateKey(date);
        const blocks = layoutsByDate[key] || [];
        return blocks.reduce((dayPeak, block) => Math.max(dayPeak, block.laneCount), peak);
      }, 1),
    [layoutsByDate, weekDates],
  );
  const weekDayMinWidth = peakWeekLaneCount * SESSION_LANE_MIN_WIDTH;
  const weekCanvasMinWidth = Math.max(
    WEEK_CANVAS_MIN_WIDTH,
    WEEK_TIME_COLUMN_WIDTH + WEEK_DAY_COUNT * weekDayMinWidth,
  );
  const weekGridTemplateColumns = `${WEEK_TIME_COLUMN_WIDTH}px repeat(${WEEK_DAY_COUNT}, minmax(${weekDayMinWidth}px, 1fr))`;
  const showCalendar = hasLoadedRange || !scheduleLoadError;
  const calendarLoadingClass = hasLoadedRange ? "" : "koaryu-skeleton-reveal";
  const rangeNoun = view === "month" ? "month" : view === "week" ? "week" : "day";
  const selectedProgram = programFilter ? programById.get(programFilter) : null;

  const stats: HorizonStat[] = [
    {
      id: "classes",
      label: "Classes",
      pending: !hasLoadedRange,
      value: <span data-schedule-figure="classes">{figures.scheduled}</span>,
      note:
        figures.recurringSlots > 0 ? (
          <span data-schedule-figure="recurring">
            +{pluralize(figures.recurringSlots, "recurring slot")}
          </span>
        ) : (
          `This ${rangeNoun}`
        ),
    },
    {
      id: "checked-in",
      label: "Checked in",
      pending: !hasLoadedRange,
      value: <span data-schedule-figure="check-ins">{figures.checkIns}</span>,
      note: figures.seats > 0 ? `of ${figures.seats} seats` : "No class capacity set",
    },
    {
      id: "open-seats",
      label: "Open seats",
      pending: !hasLoadedRange,
      value:
        figures.upcomingWithCapacity > 0 ? (
          <span data-schedule-figure="open-seats">{figures.openSeats}</span>
        ) : undefined,
      note:
        figures.upcomingWithCapacity > 0
          ? `In ${pluralize(figures.upcomingWithCapacity, "upcoming class", "upcoming classes")}`
          : `No upcoming classes this ${rangeNoun}`,
    },
    {
      id: "overlaps",
      label: "Overlaps",
      pending: !hasLoadedRange,
      value: <span data-schedule-figure="overlaps">{figures.overlaps}</span>,
      tone: figures.overlaps > 0 ? "alert" : "calm",
      note: figures.overlaps > 0 ? "Classes share a time" : "No double-booked times",
    },
  ];

  const headerDescription = todayKnown
    ? todaySessions.length === 0
      ? "No classes today."
      : `${pluralize(todaySessions.length, "class", "classes")} today${
          todayCheckIns > 0 ? `, ${todayCheckIns} checked in so far` : ""
        }.`
    : undefined;

  function renderTimeColumn(date: Date, compact: boolean) {
    const key = formatScheduleDateKey(date);
    const blocks = layoutsByDate[key] || [];
    const conflicts = getConflictingSessionIds(sessionsByDate.get(key) ?? []);
    return (
      <div
        className={`relative ${styles.canvasDay}`}
        style={{ height: canvasHeight }}
        data-time-canvas-day={key}
        data-today={compact && key === today ? "true" : undefined}
      >
        {canvasHourMarks.map((minute) => (
          <span
            key={minute}
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-0 ${styles.hourRule}`}
            style={{
              top: ((minute - canvasBounds.startMinute) / 60) * canvasBounds.hourHeight,
            }}
          />
        ))}
        {!hasLoadedRange && (
          <div aria-hidden="true" className={`absolute inset-x-0 ${styles.canvasPlaceholder}`} />
        )}
        {(hasLoadedRange ? blocks : []).map((block) => {
          const top =
            ((block.startMinute - canvasBounds.startMinute) / 60) * canvasBounds.hourHeight;
          const height = ((block.endMinute - block.startMinute) / 60) * canvasBounds.hourHeight;
          const targetHeight = Math.max(44, height);
          const targetTop = Math.max(0, top - (targetHeight - height) / 2);
          const laneWidth = 100 / block.laneCount;
          const left = laneWidth * block.lane;
          const sessionWidth = `max(44px, calc(${laneWidth}% - 4px))`;
          const sessionLeft = `min(calc(${left}% + 2px), calc(100% - ${sessionWidth} - 2px))`;
          const entry = block.item;
          const session = entry.session;
          const template = entry.template;
          const programId = session?.program_id || template?.program_id || null;
          const program = programId ? programById.get(programId) : null;
          const title = session?.name || template?.name || "Class";

          if (!session) {
            return (
              <div
                key={`template-${entry.id}`}
                className={`absolute ${styles.canvasTemplate}`}
                style={
                  {
                    top,
                    height,
                    left: `calc(${left}% + 2px)`,
                    width: `calc(${laneWidth}% - 4px)`,
                    "--program-color": getProgramColor(program),
                  } as CSSProperties
                }
                data-time-canvas-block="template"
                data-time-canvas-visible={`${entry.kind}:${entry.id}`}
              >
                <strong>{title}</strong>
                <span>{formatTime(entry.start_time)} · recurring slot</span>
              </div>
            );
          }

          const fillLabel = session.status === "canceled" ? "Canceled" : getSessionFill(session);
          const overlaps = conflicts.has(session.id);
          return (
            <button
              key={entry.id}
              type="button"
              onClick={(event) => {
                if (event.detail === 0) {
                  onOpenSession(session);
                  return;
                }

                const canvas = event.currentTarget.parentElement;
                const visibleElement = document
                  .elementsFromPoint(event.clientX, event.clientY)
                  .find(
                    (element): element is HTMLElement =>
                      element instanceof HTMLElement &&
                      Boolean(element.dataset.timeCanvasVisible) &&
                      Boolean(canvas?.contains(element)) &&
                      isPointWithinTimeCanvasFootprint(
                        element.getBoundingClientRect(),
                        event.clientX,
                        event.clientY,
                      ),
                  );
                const visibleBlock = visibleElement
                  ? blocks.find(
                      (candidate) =>
                        `${candidate.item.kind}:${candidate.item.id}` ===
                        visibleElement.dataset.timeCanvasVisible,
                    )
                  : undefined;
                if (visibleBlock) {
                  if (visibleBlock.item.session) onOpenSession(visibleBlock.item.session);
                  return;
                }
                onOpenSession(session);
              }}
              aria-label={getSessionButtonLabel(session)}
              className={`absolute ${styles.canvasTarget}`}
              style={
                {
                  top: targetTop,
                  height: targetHeight,
                  left: sessionLeft,
                  width: sessionWidth,
                  "--program-color": getProgramColor(program),
                } as CSSProperties
              }
              data-time-canvas-block="session"
              data-overlap={block.overlaps ? "true" : "false"}
            >
              <span
                aria-hidden="true"
                className={`absolute inset-x-0 ${styles.canvasBlock}`}
                style={{ height, top: top - targetTop, overflow: "hidden" }}
                data-time-canvas-visible={`${entry.kind}:${entry.id}`}
                data-conflict={overlaps ? "true" : undefined}
                data-canceled={session.status === "canceled" ? "true" : undefined}
                data-compact={compact ? "true" : undefined}
              >
                {compact ? (
                  <>
                    <span className={styles.canvasTime}>{formatTime(entry.start_time)}</span>
                    <strong className={styles.canvasTitle}>{title}</strong>
                    {fillLabel ? <span className={styles.canvasMeta}>{fillLabel}</span> : null}
                    {overlaps ? <b className={styles.overlapWord}>Overlaps</b> : null}
                  </>
                ) : (
                  <>
                    <span className={styles.canvasLine}>
                      <strong className={styles.canvasTitle}>{title}</strong>
                      <span className={styles.canvasTime}>
                        {formatTime(entry.start_time)}–{formatTime(entry.end_time)}
                      </span>
                    </span>
                    <span className={styles.canvasLine}>
                      {fillLabel ? (
                        <span className={styles.canvasMeta}>
                          {fillLabel}
                          {session.capacity && session.status !== "canceled" ? " checked in" : ""}
                        </span>
                      ) : null}
                      {program ? <span className={styles.canvasMeta}>{program.name}</span> : null}
                      {overlaps ? <b className={styles.overlapWord}>Overlaps</b> : null}
                    </span>
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  function renderHourColumn() {
    return (
      <div
        className={`relative ${styles.hourColumn}`}
        style={{ height: canvasHeight }}
        aria-hidden="true"
      >
        {canvasHourMarks.map((minute) => (
          <span
            key={minute}
            className={`absolute ${styles.hourLabel}`}
            style={{
              top: ((minute - canvasBounds.startMinute) / 60) * canvasBounds.hourHeight,
            }}
          >
            {formatCanvasHour(minute)}
          </span>
        ))}
      </div>
    );
  }

  function getToolbarLabel() {
    if (view === "day") {
      return currentDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    }

    if (view === "month") {
      return currentDate.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      });
    }

    return `${weekDates[0].toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
    })} ${DATE_RANGE_SEPARATOR} ${weekDates[6].toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })}`;
  }

  function renderTodayPanel() {
    return (
      <HorizonPanel
        className={styles.todayPanel}
        title="Today's classes"
        titleId="schedule-today-title"
      >
        {!hasLoadedRange ? (
          <div className={styles.todayList} aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className={`${styles.todayCard} ${styles.todayCardPending}`}>
                <span className={styles.pendingBar} />
                <span className={styles.pendingBar} data-width="short" />
              </div>
            ))}
          </div>
        ) : (
          <ol className={styles.todayList} data-schedule-today="true">
            {todaySessions.map((session) => {
              const program = session.program_id ? programById.get(session.program_id) : null;
              const ratio = getSessionFillRatio(session);
              const canceled = session.status === "canceled";
              const overlaps = todayConflicts.has(session.id);
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={styles.todayCard}
                    data-schedule-today-session={session.id}
                    data-canceled={canceled ? "true" : undefined}
                    aria-label={`Take attendance for ${session.name} at ${formatTime(session.start_time)}`}
                    onClick={() => onOpenSession(session)}
                    style={{ "--program-color": getProgramColor(program) } as CSSProperties}
                  >
                    <span className={styles.todayTop}>
                      <time className={styles.todayTime}>
                        {formatTime(session.start_time)}
                        <span> – {formatTime(session.end_time)}</span>
                      </time>
                      {canceled ? <ToneTag>Canceled</ToneTag> : null}
                      {overlaps && !canceled ? <ToneTag tone="alert">Overlaps</ToneTag> : null}
                    </span>
                    <strong className={styles.todayName}>{session.name}</strong>
                    <span className={styles.todayProgram}>
                      <i aria-hidden="true" />
                      {program?.name ?? "All programs"}
                    </span>
                    <span className={styles.todayFill}>
                      {ratio !== null ? (
                        <span className={styles.meter} aria-hidden="true">
                          <span style={{ width: `${ratio * 100}%` }} />
                        </span>
                      ) : null}
                      <span>
                        <b>{canceled ? "—" : session.attendance_count}</b>
                        {session.capacity && !canceled ? ` / ${session.capacity}` : ""} checked in
                      </span>
                    </span>
                    <span className={styles.todayAction}>
                      <CalendarCheck aria-hidden="true" />
                      Take attendance
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </HorizonPanel>
    );
  }

  return (
    <>
      <Header eyebrow={formatLongDate(todayDate)} title="Schedule" description={headerDescription}>
        {canManageSchedule ? (
          <Button variant="primary" onClick={onOpenAddClass}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add class
          </Button>
        ) : null}
      </Header>

      <HorizonPage className={styles.page}>
        <HorizonStats label="Visible schedule range" items={stats} />

        {scheduleLoadError ? (
          <DismissibleNotice tone="danger" onDismiss={onDismissScheduleLoadError}>
            {scheduleLoadError}
            <Button variant="ghost" size="sm" onClick={onRetryRange}>
              Retry
            </Button>
          </DismissibleNotice>
        ) : null}

        {actionMessage ? (
          <DismissibleNotice tone="success" onDismiss={onDismissActionMessage}>
            {actionMessage}
          </DismissibleNotice>
        ) : null}

        {routeTargetNotice && onDismissRouteTargetNotice ? (
          <DismissibleNotice tone="warning" onDismiss={onDismissRouteTargetNotice}>
            {routeTargetNotice}
          </DismissibleNotice>
        ) : null}

        {showTodayPanel ? renderTodayPanel() : null}

        <section className={styles.calendar} aria-labelledby="schedule-range-label">
          <div className={styles.toolbar}>
            <div className={styles.dateNav} role="group" aria-label="Schedule date navigation">
              <button
                type="button"
                onClick={() => onNavigate(-1)}
                aria-label={`Previous ${view}`}
                className={styles.navButton}
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={onJumpToToday}
                aria-label="Jump to today"
                className={styles.todayButton}
                data-current={todayInView ? "true" : undefined}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => onNavigate(1)}
                aria-label={`Next ${view}`}
                className={styles.navButton}
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
            <h2 id="schedule-range-label" className={styles.rangeLabel} data-schedule-range-label>
              {getToolbarLabel()}
            </h2>
            <div className={styles.toolbarEnd}>
              <div
                className={styles.programFilter}
                style={
                  selectedProgram
                    ? ({ "--program-color": getProgramColor(selectedProgram) } as CSSProperties)
                    : undefined
                }
                data-selected={programFilter ? "true" : undefined}
              >
                <select
                  value={programFilter}
                  onChange={(event) => onProgramFilterChange(event.target.value)}
                  aria-label="Filter schedule by program"
                  data-schedule-program-filter={programFilter ? "selected" : "all"}
                  className={styles.programSelect}
                >
                  <option value="">All programs</option>
                  {activePrograms.map((program) => (
                    <option key={program.id} value={program.id}>
                      {program.name}
                    </option>
                  ))}
                </select>
                {programFilter ? (
                  <button
                    type="button"
                    className={styles.clearFilter}
                    aria-label="Show every program"
                    onClick={() => onProgramFilterChange("")}
                  >
                    <X aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <SlidingSegmentedControl
                activeValue={view}
                ariaLabel="Schedule view"
                className={styles.viewSwitch}
                items={SCHEDULE_VIEWS.map((nextView) => ({
                  id: nextView,
                  label: nextView[0].toUpperCase() + nextView.slice(1),
                }))}
                onChange={onViewChange}
                size="compact"
              />
            </div>
          </div>

          {!hasLoadedRange ? (
            scheduleLoadError ? (
              <p role="status" className={styles.rangeStatus}>
                This calendar range is unavailable. Retry or choose another range.
              </p>
            ) : (
              <span role="status" aria-live="polite" className="sr-only">
                Loading this calendar range...
              </span>
            )
          ) : isRefreshingRange ? (
            <p role="status" className={styles.rangeStatus}>
              Refreshing calendar. Showing the last loaded schedule.
            </p>
          ) : null}

          {showCalendar && view === "month" && (
            <div
              className={`${styles.monthFrame} ${calendarLoadingClass}`}
              aria-busy={!hasLoadedRange}
            >
              <MonthScheduleView
                month={currentDate}
                sessions={hasLoadedRange ? filteredSessions : []}
                templates={hasLoadedRange ? filteredTemplates : []}
                programById={programById}
                isLoading={!hasLoadedRange}
                selectedDate={currentDate}
                today={todayDate}
                maxVisibleEntries={3}
                showHeader={false}
                showTemplatePlaceholders
                onDayClick={onSelectDate}
                onEntryClick={(entry) => {
                  if (entry.kind === "session") {
                    onOpenSession(entry.session);
                  }
                }}
                onMoreClick={(date) => {
                  onSelectDate(date);
                  onViewChange("day");
                }}
              />
            </div>
          )}

          {showCalendar && view === "week" && (
            <>
              <div
                className={`flex-1 overflow-x-auto overscroll-x-contain ${styles.weekScroller} ${calendarLoadingClass}`}
                aria-busy={!hasLoadedRange}
                data-schedule-screen-week="true"
                data-schedule-scroll-owner="internal"
                role="region"
                tabIndex={0}
                aria-label="Scrollable weekly time canvas"
              >
                <div
                  className={styles.canvas}
                  style={{ minWidth: weekCanvasMinWidth }}
                  data-schedule-time-canvas="week"
                  data-schedule-week-peak-lanes={peakWeekLaneCount}
                >
                  <div
                    className={`grid ${styles.weekHead}`}
                    style={{ gridTemplateColumns: weekGridTemplateColumns }}
                  >
                    <div className={styles.weekCorner} aria-hidden="true" />
                    {weekDates.map((date) => {
                      const key = formatScheduleDateKey(date);
                      const isToday = key === today;
                      return (
                        <div
                          key={key}
                          className={styles.weekDay}
                          data-today={isToday ? "true" : undefined}
                          aria-current={isToday ? "date" : undefined}
                        >
                          <p className={styles.weekDayName}>{DAY_NAMES[date.getDay()]}</p>
                          <p className={styles.weekDayNumber}>{date.getDate()}</p>
                        </div>
                      );
                    })}
                  </div>
                  <div className="grid" style={{ gridTemplateColumns: weekGridTemplateColumns }}>
                    {renderHourColumn()}
                    {weekDates.map((date) => (
                      <div key={formatScheduleDateKey(date)}>{renderTimeColumn(date, true)}</div>
                    ))}
                  </div>
                </div>
              </div>

              <section data-schedule-print-week="true" aria-label="Weekly schedule">
                {(hasLoadedRange ? weekDates : []).map((date) => {
                  const key = formatScheduleDateKey(date);
                  const entries = (layoutsByDate[key] || []).map((block) => block.item);
                  return (
                    <section key={key} data-schedule-print-day={key}>
                      <header data-schedule-print-day-header="true">
                        <strong>
                          {DAY_NAMES[date.getDay()]} {date.getDate()}
                        </strong>
                      </header>
                      {entries.length === 0 ? (
                        <p data-schedule-print-empty="true">No sessions scheduled.</p>
                      ) : null}
                      {entries.map((entry) => {
                        const programId =
                          entry.session?.program_id || entry.template?.program_id || null;
                        const program = programId ? programById.get(programId) : null;
                        return (
                          <article
                            key={`${entry.kind}-${entry.id}`}
                            data-schedule-print-entry={entry.kind}
                          >
                            <span>
                              {formatTime(entry.start_time)}–{formatTime(entry.end_time)}
                            </span>
                            <strong>
                              {entry.session?.name || entry.template?.name || "Class"}
                            </strong>
                            {program ? <span>{program.name}</span> : null}
                            {entry.kind === "template" ? <span>Recurring</span> : null}
                          </article>
                        );
                      })}
                    </section>
                  );
                })}
              </section>

              <style>{`
            [data-schedule-print-week="true"] {
              display: none;
            }

            @media print {
              [data-schedule-screen-week="true"] {
                display: none !important;
              }

              [data-schedule-print-week="true"] {
                box-sizing: border-box;
                display: grid !important;
                grid-template-columns: repeat(7, minmax(0, 1fr));
                width: 100% !important;
                max-width: 100% !important;
                overflow: visible !important;
                border-block: 1px solid #999;
                background: #fff !important;
                color: #000 !important;
              }

              [data-schedule-print-day] {
                box-sizing: border-box;
                min-width: 0;
                padding: 4px;
                border-right: 1px solid #999;
                background: #fff !important;
                color: #000 !important;
              }

              [data-schedule-print-day]:last-child {
                border-right: 0;
              }

              [data-schedule-print-day-header="true"] {
                display: block;
                min-height: 22px;
                padding-bottom: 3px;
                border-bottom: 1px solid #bbb;
                font-size: 9px;
                line-height: 1.2;
              }

              [data-schedule-print-entry] {
                box-sizing: border-box;
                display: block;
                min-width: 0;
                margin-top: 4px;
                padding: 3px;
                break-inside: avoid;
                overflow: visible;
                border: 1px solid #bbb;
                background: #fff !important;
                color: #000 !important;
                font-size: 8px;
                line-height: 1.25;
                overflow-wrap: anywhere;
              }

              [data-schedule-print-entry] > * {
                display: block;
                max-width: 100%;
                white-space: normal;
              }

              [data-schedule-print-empty="true"] {
                margin-top: 4px;
                font-size: 8px;
                line-height: 1.25;
              }
            }
          `}</style>
            </>
          )}

          {showCalendar && view === "day" && (
            <div
              className={`${styles.dayFrame} ${calendarLoadingClass}`}
              aria-busy={!hasLoadedRange}
            >
              {hasLoadedRange &&
              (entriesByDate[formatScheduleDateKey(currentDate)] || []).length === 0 ? (
                <CalmState
                  tone="neutral"
                  icon={<CalendarPlus />}
                  title="No sessions scheduled for this day."
                  detail={
                    canManageSchedule
                      ? "Add a class here, or move to another day."
                      : "Move to another day to see its classes."
                  }
                  action={
                    canManageSchedule ? (
                      <Button variant="secondary" size="sm" onClick={onOpenAddClass}>
                        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                        Add class
                      </Button>
                    ) : null
                  }
                />
              ) : (
                <div
                  className={`grid ${styles.canvas} ${styles.dayCanvas}`}
                  data-schedule-time-canvas="day"
                >
                  {renderHourColumn()}
                  {renderTimeColumn(currentDate, false)}
                </div>
              )}
            </div>
          )}
        </section>
      </HorizonPage>
    </>
  );
}
