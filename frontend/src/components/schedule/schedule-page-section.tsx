"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CalendarCheck, CalendarPlus, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";

import { Header } from "@/components/header";
import { MonthScheduleView } from "@/components/schedule/month-schedule-view";
import {
  formatClockTime,
  getProgramColor,
  getSessionFill,
  pluralize,
} from "@/components/schedule/schedule-display";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { RevealText } from "@/components/ui/reveal-text";
import { CalmState, HorizonPage, ToneTag } from "@/components/schedule/horizon-parts";
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
  getScheduleCanvasRange,
  getScheduleWeekDates,
  getVisibleScheduleRange,
  layoutScheduleTimeItems,
  SCHEDULE_CANVAS_PIXELS_PER_HOUR,
  type SchedulePageView,
  type ScheduleTimeBlock,
} from "@/lib/schedule-page-model";
import { useStudioClock } from "@/lib/use-studio-clock";
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
  /** The studio's timezone, for the now line on today's column; none without it. */
  studioTimezone?: string;
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
const WEEK_CANVAS_MIN_WIDTH = 672;
const WEEK_TIME_COLUMN_WIDTH = 56;
const WEEK_DAY_COUNT = 7;
const WEEK_DAY_MIN_WIDTH = 88;
const SESSION_LANE_MIN_WIDTH = 64;
/** A sheet this narrow is a phone: Week reads as an agenda and Day draws taller hours. */
const PHONE_SHEET_MAX_WIDTH = 608;
const PHONE_DAY_HOUR_HEIGHT = 56;
/** Every text line in a block is 14px, so a block shows only whole lines. */
const BLOCK_LINE_HEIGHT = 14;
const BLOCK_MIN_HEIGHT = 36;
const BLOCK_PADDING_BLOCK = 6;
const PENDING_TILE_MINUTE = 16 * 60;
const NO_SESSIONS = new Map<string, ClassSession[]>();

type TimeCanvasEntry = {
  id: string;
  kind: "session" | "template";
  start_time: string;
  end_time: string;
  session?: ClassSession;
  template?: ClassTemplate;
};

function getCanvasOccupiedInterval(
  block: Pick<ScheduleTimeBlock<TimeCanvasEntry>, "item" | "startMinute" | "endMinute">,
  canvasStartMinute: number,
  hourHeight: number,
) {
  const pixelsPerMinute = hourHeight / 60;
  const top = (block.startMinute - canvasStartMinute) * pixelsPerMinute;
  const visibleHeight = Math.max(
    BLOCK_MIN_HEIGHT,
    (block.endMinute - block.startMinute) * pixelsPerMinute,
  );
  const targetHeight = block.item.kind === "session" ? Math.max(44, visibleHeight) : visibleHeight;
  const occupiedTop = Math.max(0, top - (targetHeight - visibleHeight) / 2);
  return {
    startMinute: canvasStartMinute + occupiedTop / pixelsPerMinute,
    endMinute: canvasStartMinute + (occupiedTop + targetHeight) / pixelsPerMinute,
  };
}

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

function getAttendanceLabel(session: ClassSession) {
  return `Take attendance for ${session.name} at ${formatTime(session.start_time)}`;
}

/** "4:00–4:45 PM", or "11:30 AM–12:30 PM" across noon. */
function formatTimeRange(start: string, end: string) {
  const from = formatTime(start);
  const to = formatTime(end);
  return from.slice(-2) === to.slice(-2) ? `${from.slice(0, -3)}–${to}` : `${from}–${to}`;
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

/** "October 11 – 17, 2026", "October 26 – November 1, 2026" or across a new year in full. */
function formatWeekLabel(first: Date, last: Date) {
  if (first.getFullYear() !== last.getFullYear()) {
    const full = (date: Date) =>
      date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    return `${full(first)} ${DATE_RANGE_SEPARATOR} ${full(last)}`;
  }
  const month = (date: Date) => date.toLocaleDateString("en-US", { month: "long" });
  const end =
    first.getMonth() === last.getMonth() ? `${last.getDate()}` : `${month(last)} ${last.getDate()}`;
  return `${month(first)} ${first.getDate()} ${DATE_RANGE_SEPARATOR} ${end}, ${last.getFullYear()}`;
}

/** A length on the time canvas, in the sheet's hours (48px, or 56px for Day on a phone). */
function hours(value: number) {
  return `calc(var(--hour, ${SCHEDULE_CANVAS_PIXELS_PER_HOUR}px) * ${Number(value.toFixed(4))})`;
}

/**
 * Whether the sheet is phone-width. Null until measured: both layouts render
 * until then and the sheet's container queries show the right one, so the
 * first paint never shifts. Measured before paint, so only one stays mounted.
 */
function usePhoneSheet() {
  const ref = useRef<HTMLElement>(null);
  const [phone, setPhone] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number) => setPhone(width <= PHONE_SHEET_MAX_WIDTH);
    update(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, phone] as const;
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
  studioTimezone,
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
  const [calendarRef, phoneSheet] = usePhoneSheet();
  const studioMinute = useStudioClock(studioTimezone);
  const programDescriptionId = useId();
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
  const visibleRange = useMemo(
    () => getVisibleScheduleRange(currentDate, view),
    [currentDate, view],
  );
  // Today's classes are only known when the loaded range covers the business date.
  const todayInView = today >= visibleRange.start && today <= visibleRange.end;
  const todayKnown = todayInView && hasLoadedRange;

  const sessionsByDate = useMemo(() => groupSessionsByDate(filteredSessions), [filteredSessions]);
  const templatesByDay = useMemo(() => groupTemplatesByDay(filteredTemplates), [filteredTemplates]);
  const todayTemplateEntries = useMemo(
    () =>
      buildEntriesForDate({
        date: todayDate,
        sessionsByDate: NO_SESSIONS,
        templatesByDay,
        showTemplatePlaceholders: true,
      }).filter((entry) => entry.kind === "template"),
    [templatesByDay, todayDate],
  );
  const todaySessions = useMemo(() => sessionsByDate.get(today) ?? [], [sessionsByDate, today]);
  const todayCheckIns = todaySessions.reduce(
    (total, session) =>
      total + (session.status === "canceled" ? 0 : Math.max(0, session.attendance_count || 0)),
    0,
  );
  // The Day view of today already is today's list, and on a phone today's
  // classes open the agendas; elsewhere the bar keeps attendance one tap away.
  const showTodayBar =
    todayInView &&
    view !== "day" &&
    phoneSheet !== true &&
    (!hasLoadedRange || todaySessions.length > 0);

  // Until the range loads, the studio's recurring classes already give the canvas its hours.
  const canvasSessionsByDate = hasLoadedRange ? sessionsByDate : NO_SESSIONS;
  const entriesByDate = useMemo(() => {
    const grouped: Record<string, TimeCanvasEntry[]> = {};
    const dates = view === "day" ? [currentDate] : weekDates;
    dates.forEach((date) => {
      const key = formatScheduleDateKey(date);
      grouped[key] = buildEntriesForDate({
        date,
        sessionsByDate: canvasSessionsByDate,
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
  }, [canvasSessionsByDate, currentDate, templatesByDay, view, weekDates]);
  const canvasRange = useMemo(
    () => getScheduleCanvasRange(Object.values(entriesByDate).flat()),
    [entriesByDate],
  );
  // Match the actual CSS scale when reserving cards and their centred targets.
  const hourHeight =
    view === "day" && phoneSheet ? PHONE_DAY_HOUR_HEIGHT : SCHEDULE_CANVAS_PIXELS_PER_HOUR;
  const layoutsByDate = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(entriesByDate).map(([key, entries]) => [
          key,
          layoutScheduleTimeItems(entries, {
            getOccupiedInterval: (block) =>
              getCanvasOccupiedInterval(block, canvasRange.startMinute, hourHeight),
          }),
        ]),
      ),
    [canvasRange.startMinute, entriesByDate, hourHeight],
  );
  const canvasHourMarks = useMemo(
    () =>
      Array.from(
        { length: Math.floor((canvasRange.endMinute - canvasRange.startMinute) / 60) + 1 },
        (_, index) => canvasRange.startMinute + index * 60,
      ),
    [canvasRange.endMinute, canvasRange.startMinute],
  );
  const canvasHours = (canvasRange.endMinute - canvasRange.startMinute) / 60;
  const canvasOverhang = Math.max(
    0,
    ...Object.values(layoutsByDate)
      .flat()
      .map(
        (block) =>
          ((getCanvasOccupiedInterval(block, canvasRange.startMinute, hourHeight).endMinute -
            canvasRange.endMinute) *
            hourHeight) /
          60,
      ),
  );
  const peakWeekLaneCount = useMemo(
    () =>
      weekDates.reduce((peak, date) => {
        const key = formatScheduleDateKey(date);
        const blocks = layoutsByDate[key] || [];
        return blocks.reduce((dayPeak, block) => Math.max(dayPeak, block.laneCount), peak);
      }, 1),
    [layoutsByDate, weekDates],
  );
  const weekDayMinWidth = Math.max(WEEK_DAY_MIN_WIDTH, peakWeekLaneCount * SESSION_LANE_MIN_WIDTH);
  const weekCanvasMinWidth = Math.max(
    WEEK_CANVAS_MIN_WIDTH,
    WEEK_TIME_COLUMN_WIDTH + WEEK_DAY_COUNT * weekDayMinWidth,
  );
  const weekGridTemplateColumns = `${WEEK_TIME_COLUMN_WIDTH}px repeat(${WEEK_DAY_COUNT}, minmax(${weekDayMinWidth}px, 1fr))`;
  const showCalendar = hasLoadedRange || !scheduleLoadError;
  const calendarLoadingClass = hasLoadedRange ? "" : "koaryu-skeleton-reveal";
  const selectedProgram = programFilter ? programById.get(programFilter) : null;
  const selectedProgramName = programFilter
    ? (selectedProgram?.name ?? "Selected program unavailable")
    : "All programs";
  const selectedProgramUnavailable =
    Boolean(programFilter) && !activePrograms.some((program) => program.id === programFilter);
  const dayEntries = entriesByDate[formatScheduleDateKey(currentDate)] || [];
  const dayLaneCount = (layoutsByDate[formatScheduleDateKey(currentDate)] || []).reduce(
    (peak, block) => Math.max(peak, block.laneCount),
    1,
  );
  const dayCanvasMinWidth =
    (phoneSheet ? 44 : WEEK_TIME_COLUMN_WIDTH) + dayLaneCount * SESSION_LANE_MIN_WIDTH;

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
    const isToday = key === today;
    const nowMinute =
      isToday &&
      studioMinute !== null &&
      studioMinute >= canvasRange.startMinute &&
      studioMinute <= canvasRange.endMinute
        ? studioMinute
        : null;
    // One tile where the day's first recurring class will land.
    const pendingMinute = Math.min(
      Math.max(blocks[0]?.startMinute ?? PENDING_TILE_MINUTE, canvasRange.startMinute),
      canvasRange.endMinute - 60,
    );
    return (
      <div
        className={`relative ${styles.canvasDay}`}
        style={{ height: `calc(${hours(canvasHours)} + ${canvasOverhang}px)` }}
        data-time-canvas-day={key}
        data-today={compact && isToday ? "true" : undefined}
      >
        {canvasHourMarks.map((minute) => (
          <span
            key={minute}
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-0 ${styles.hourRule}`}
            style={{ top: hours((minute - canvasRange.startMinute) / 60) }}
          />
        ))}
        {!hasLoadedRange && (
          <div
            aria-hidden="true"
            className={`absolute inset-x-0 ${styles.canvasPlaceholder}`}
            style={{ top: hours((pendingMinute - canvasRange.startMinute) / 60) }}
          />
        )}
        {(hasLoadedRange ? blocks : []).map((block) => {
          const startHours = (block.startMinute - canvasRange.startMinute) / 60;
          const durationHours = (block.endMinute - block.startMinute) / 60;
          const top = hours(startHours);
          const duration = hours(durationHours);
          const visibleHeight = `max(${BLOCK_MIN_HEIGHT}px, ${duration})`;
          const targetHeight = `max(44px, ${duration})`;
          // The target is centred on the block, but never above the canvas.
          const targetInset = `(${targetHeight} - ${visibleHeight}) / 2`;
          const targetTop = `max(0px, ${top} - ${targetInset})`;
          const blockLines = Math.max(
            1,
            Math.floor(
              (Math.max(BLOCK_MIN_HEIGHT, durationHours * hourHeight) - BLOCK_PADDING_BLOCK) /
                BLOCK_LINE_HEIGHT,
            ),
          );
          const laneWidth = 100 / block.laneCount;
          const left = laneWidth * block.lane;
          const laneLeft = `calc(${left}% + 1px)`;
          const laneBlockWidth = `calc(${laneWidth}% - 2px)`;
          const sessionWidth = `max(44px, ${laneBlockWidth})`;
          const sessionLeft = `min(${laneLeft}, calc(100% - ${sessionWidth} - 1px))`;
          const sharedLane = block.laneCount >= 2 ? "true" : undefined;
          const entry = block.item;
          const session = entry.session;
          const template = entry.template;
          const programId = session?.program_id || template?.program_id || null;
          const program = programId ? programById.get(programId) : null;
          const title = session?.name || template?.name || "Class";
          const timeRange = formatTimeRange(entry.start_time, entry.end_time);

          if (!session) {
            return (
              <div
                key={`template-${entry.id}`}
                className={`absolute ${styles.canvasTemplate}`}
                style={
                  {
                    top,
                    height: visibleHeight,
                    left: laneLeft,
                    width: laneBlockWidth,
                    "--program-color": getProgramColor(program),
                    "--block-lines": blockLines,
                    "--block-height": visibleHeight,
                  } as CSSProperties
                }
                title={`${title} · ${timeRange} · Recurring`}
                data-time-canvas-block="template"
                data-time-canvas-visible={`${entry.kind}:${entry.id}`}
                data-shared-lane={sharedLane}
                data-compact={compact ? "true" : undefined}
              >
                <span className={styles.canvasLines}>
                  <RevealText as="strong" className={styles.canvasTitle}>
                    {title}
                  </RevealText>
                  <span className={styles.canvasMeta}>Recurring</span>
                </span>
              </div>
            );
          }

          const canceled = session.status === "canceled";
          const fill = getSessionFill(session);
          const fillLabel = canceled ? "Canceled" : fill;
          const overlaps = conflicts.has(session.id);
          // A name cut at a whole line is still said in full on hover.
          const hoverTitle = [title, timeRange, fillLabel].filter(Boolean).join(" · ");
          const dayFacts = [
            fillLabel && !canceled && session.capacity ? `${fillLabel} checked in` : fillLabel,
            program?.name,
          ].filter(Boolean);
          return (
            <button
              key={entry.id}
              type="button"
              onClick={(event) => {
                if (event.detail === 0) {
                  onOpenSession(session);
                  return;
                }

                // A click on this block's own drawn card opens it, even when an opened
                // name has just folded and the point now shows a neighbour.
                const clickedCard =
                  event.target instanceof Element
                    ? event.target.closest("[data-time-canvas-visible]")
                    : null;
                if (clickedCard && event.currentTarget.contains(clickedCard)) {
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
              title={hoverTitle}
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
                style={
                  {
                    height: visibleHeight,
                    top: `min(${top}, ${targetInset})`,
                    overflow: "hidden",
                    "--block-lines": blockLines,
                    "--block-height": visibleHeight,
                  } as CSSProperties
                }
                data-time-canvas-visible={`${entry.kind}:${entry.id}`}
                data-conflict={overlaps ? "true" : undefined}
                data-canceled={canceled ? "true" : undefined}
                data-compact={compact ? "true" : undefined}
                data-shared-lane={sharedLane}
              >
                {compact ? (
                  <span className={styles.canvasLines}>
                    <RevealText as="strong" className={styles.canvasTitle}>
                      {title}
                    </RevealText>
                    <span className={styles.canvasMeta}>
                      {formatTime(entry.start_time)}
                      {fillLabel ? ` · ${fillLabel}` : ""}
                    </span>
                    {overlaps ? <b className={styles.overlapWord}>Overlaps</b> : null}
                    {program ? <span className={styles.canvasProgram}>{program.name}</span> : null}
                  </span>
                ) : (
                  <span className={styles.canvasLines}>
                    <span className={styles.canvasLine}>
                      <strong className={styles.canvasTitle}>{title}</strong>{" "}
                      <span className={styles.canvasTime}>{timeRange}</span>
                    </span>
                    {dayFacts.length > 0 || overlaps ? (
                      <span className={styles.canvasMeta}>
                        {dayFacts.join(" · ")}
                        {overlaps ? (
                          <>
                            {dayFacts.length > 0 ? " · " : ""}
                            <b className={styles.overlapWord}>Overlaps</b>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        {nowMinute !== null ? (
          <span
            aria-hidden="true"
            className={`absolute inset-x-0 ${styles.nowLine}`}
            style={{ top: hours((nowMinute - canvasRange.startMinute) / 60) }}
            data-schedule-now-line="true"
          />
        ) : null}
      </div>
    );
  }

  function renderHourColumn() {
    return (
      <div
        className={`relative ${styles.hourColumn}`}
        style={{ height: hours(canvasHours) }}
        aria-hidden="true"
      >
        {canvasHourMarks.map((minute) => (
          <span
            key={minute}
            className={`absolute ${styles.hourLabel}`}
            style={{ top: hours((minute - canvasRange.startMinute) / 60) }}
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

    return formatWeekLabel(weekDates[0], weekDates[6]);
  }

  function renderTodayBar() {
    return (
      <section
        className={styles.todayBar}
        aria-labelledby="schedule-today-title"
        data-schedule-today-bar="true"
      >
        <h2 id="schedule-today-title" className={styles.todayTitle}>
          <CalendarCheck aria-hidden="true" />
          Take attendance
        </h2>
        {!hasLoadedRange && todayTemplateEntries.length > 0 ? (
          <ol className={styles.todayList} aria-hidden="true">
            {todayTemplateEntries.map(({ template }) => (
              <li key={template.id}>
                <div className={`${styles.todayChip} ${styles.todayChipLoading}`}>
                  <span className={styles.todayChipTime}>{formatTime(template.start_time)}</span>
                  <strong className={styles.todayChipName}>{template.name}</strong>
                  {/* Hidden text sizes the unknown attendance fact without displaying a count. */}
                  <span className={styles.todayChipFill}>
                    {template.capacity ? `0/${template.capacity}` : "0 in"}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        ) : !hasLoadedRange ? (
          <div className={styles.todayList} aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <span key={index} className={styles.todayChipPending} />
            ))}
          </div>
        ) : (
          <ol className={styles.todayList} data-schedule-today="true" aria-label="Today's classes">
            {todaySessions.map((session) => {
              const program = session.program_id ? programById.get(session.program_id) : null;
              const canceled = session.status === "canceled";
              const fill = getSessionFill(session);
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={styles.todayChip}
                    data-schedule-today-session={session.id}
                    disabled={canceled}
                    data-canceled={canceled ? "true" : undefined}
                    aria-label={
                      canceled ? getSessionButtonLabel(session) : getAttendanceLabel(session)
                    }
                    onClick={canceled ? undefined : () => onOpenSession(session)}
                    style={{ "--program-color": getProgramColor(program) } as CSSProperties}
                  >
                    <time className={styles.todayChipTime}>{formatTime(session.start_time)}</time>
                    <strong className={styles.todayChipName}>{session.name}</strong>
                    {fill ? <span className={styles.todayChipFill}>{fill}</span> : null}
                    {canceled ? <ToneTag>Canceled</ToneTag> : null}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    );
  }

  function renderAgendaEntry(entry: TimeCanvasEntry, isToday: boolean, conflicts: Set<string>) {
    const session = entry.session;
    const programId = session?.program_id || entry.template?.program_id || null;
    const program = programId ? programById.get(programId) : null;
    const style = { "--program-color": getProgramColor(program) } as CSSProperties;
    const name = session?.name || entry.template?.name || "Class";
    const time = <time className={styles.agendaTime}>{formatTime(entry.start_time)}</time>;

    if (!session) {
      return (
        <div className={styles.agendaRow} data-template="true" style={style}>
          <span className={styles.agendaBar} aria-hidden="true" />
          {time}
          <span className={styles.agendaText}>
            <span className={styles.agendaName}>{name}</span>
          </span>
          <span className={styles.agendaFill}>Recurring</span>
        </div>
      );
    }

    const canceled = session.status === "canceled";
    const fill = getSessionFill(session);
    return (
      <button
        type="button"
        className={styles.agendaRow}
        aria-label={isToday ? getAttendanceLabel(session) : getSessionButtonLabel(session)}
        data-canceled={canceled ? "true" : undefined}
        data-action={isToday ? "attendance" : undefined}
        onClick={() => onOpenSession(session)}
        style={style}
      >
        <span className={styles.agendaBar} aria-hidden="true" />
        {time}
        <span className={styles.agendaText}>
          <span className={styles.agendaName}>{name}</span>
          {canceled ? (
            <ToneTag>Canceled</ToneTag>
          ) : conflicts.has(session.id) ? (
            <ToneTag tone="alert">Overlaps</ToneTag>
          ) : null}
        </span>
        {fill ? <span className={styles.agendaFill}>{fill}</span> : null}
        {isToday ? <CalendarCheck aria-hidden="true" className={styles.agendaAction} /> : null}
      </button>
    );
  }

  /** Week on a phone: every day stacked, today's classes one tap from attendance. */
  function renderWeekAgenda() {
    return (
      <ol
        className={`${styles.agenda} ${phoneSheet ? calendarLoadingClass : ""}`}
        data-schedule-agenda="week"
        aria-busy={!hasLoadedRange}
      >
        {weekDates.map((date) => {
          const key = formatScheduleDateKey(date);
          const isToday = key === today;
          const entries = hasLoadedRange ? entriesByDate[key] || [] : [];
          const conflicts = getConflictingSessionIds(sessionsByDate.get(key) ?? []);
          return (
            <li
              key={key}
              className={styles.agendaDay}
              data-schedule-agenda-day={key}
              data-today={isToday ? "true" : undefined}
            >
              <div className={styles.agendaDayLine}>
                <button
                  type="button"
                  className={styles.agendaDayHead}
                  aria-label={`Open ${formatLongDate(date)}`}
                  aria-current={isToday ? "date" : undefined}
                  onClick={() => {
                    onSelectDate(date);
                    onViewChange("day");
                  }}
                >
                  <span className={styles.agendaDayName}>{DAY_NAMES[date.getDay()]}</span>
                  <span className={styles.agendaDayNumber}>{date.getDate()}</span>
                  {isToday ? <span className={styles.agendaTodayWord}>Today</span> : null}
                </button>
                {hasLoadedRange && entries.length === 0 ? (
                  <span className={styles.agendaEmpty}>No classes</span>
                ) : null}
              </div>
              {!hasLoadedRange ? (
                <div className={styles.agendaRows} aria-hidden="true">
                  <span className={styles.agendaPending} />
                </div>
              ) : entries.length > 0 ? (
                <ul className={styles.agendaRows}>
                  {entries.map((entry) => (
                    <li key={`${entry.kind}-${entry.id}`}>
                      {renderAgendaEntry(entry, isToday, conflicts)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    );
  }

  const hasNotices = Boolean(
    scheduleLoadError || actionMessage || (routeTargetNotice && onDismissRouteTargetNotice),
  );

  return (
    <>
      <Header title="Schedule" description={headerDescription} reserveDescription>
        {canManageSchedule ? (
          <Button variant="primary" onClick={onOpenAddClass}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add class
          </Button>
        ) : null}
      </Header>

      <HorizonPage className={styles.page}>
        <section
          ref={calendarRef}
          className={styles.calendar}
          aria-labelledby="schedule-range-label"
        >
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
                  aria-describedby={programDescriptionId}
                  title={selectedProgramName}
                  data-schedule-program-filter={programFilter ? "selected" : "all"}
                  className={styles.programSelect}
                >
                  <option value="">All programs</option>
                  {selectedProgramUnavailable ? (
                    <option value={programFilter} disabled>
                      {selectedProgramName}
                    </option>
                  ) : null}
                  {activePrograms.map((program) => (
                    <option key={program.id} value={program.id}>
                      {program.name}
                    </option>
                  ))}
                </select>
                <span id={programDescriptionId} className="sr-only">
                  {selectedProgramName}
                </span>
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

          {hasNotices ? (
            <div className={styles.notices}>
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
            </div>
          ) : null}

          {showTodayBar ? renderTodayBar() : null}

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
            <span role="status" aria-live="polite" className="sr-only">
              Refreshing calendar. Showing the last loaded schedule.
            </span>
          ) : null}

          {showCalendar && view === "month" && (
            <div
              className={`${styles.monthFrame} ${calendarLoadingClass}`}
              aria-busy={!hasLoadedRange}
            >
              <MonthScheduleView
                month={currentDate}
                sessions={hasLoadedRange ? filteredSessions : []}
                templates={filteredTemplates}
                programById={programById}
                isLoading={!hasLoadedRange}
                selectedDate={currentDate}
                today={todayDate}
                maxVisibleEntries={4}
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
              {phoneSheet !== true ? (
                <div
                  className={`flex-1 overflow-x-auto overscroll-x-contain ${styles.weekScroller} ${phoneSheet === false ? calendarLoadingClass : ""}`}
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
                            <span className={styles.weekDayName}>{DAY_NAMES[date.getDay()]}</span>
                            <span className={styles.weekDayNumber}>{date.getDate()}</span>
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
              ) : null}

              {phoneSheet !== false ? renderWeekAgenda() : null}

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
                        <p data-schedule-print-empty="true">No classes.</p>
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
              style={{ overflowX: "auto" }}
            >
              {hasLoadedRange && dayEntries.length === 0 ? (
                <div className={styles.dayEmpty}>
                  <CalmState
                    tone="neutral"
                    icon={<CalendarPlus />}
                    title="No classes on this day."
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
                </div>
              ) : (
                <div
                  className={`grid ${styles.canvas} ${styles.dayCanvas}`}
                  data-schedule-time-canvas="day"
                  style={{ minWidth: dayCanvasMinWidth }}
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
