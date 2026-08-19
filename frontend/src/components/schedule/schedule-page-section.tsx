"use client";

import { useMemo, type CSSProperties } from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Plus,
} from "lucide-react";

import { ProgramBadge } from "@/components/programs/program-picker";
import { Header } from "@/components/header";
import { MonthScheduleView } from "@/components/schedule/month-schedule-view";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { SlidingSegmentedControl } from "@/components/ui/sliding-segmented-control";
import {
  formatScheduleDateKey,
  getScheduleTimeCanvasBounds,
  getScheduleWeekDates,
  layoutScheduleTimeItems,
  SCHEDULE_CANVAS_PIXELS_PER_HOUR,
  type SchedulePageView,
} from "@/lib/schedule-page-model";
import type { ClassSession, ClassTemplate, Program } from "@/types";

interface SchedulePageSectionProps {
  canManageSchedule: boolean;
  currentDate: Date;
  view: SchedulePageView;
  programFilter: string;
  sessions: ClassSession[];
  templates: ClassTemplate[];
  programs: Program[];
  scheduleLoadError: string | null;
  actionMessage: string | null;
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
  clientY: number
) {
  return (
    clientY >= footprint.top &&
    clientY < footprint.bottom &&
    clientX >= footprint.left &&
    clientX < footprint.right
  );
}

function formatTime(value: string) {
  const [hoursText = "0", minutes = "00"] = value.split(":");
  const hours = Number(hoursText);
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${hour12}:${minutes.slice(0, 2)} ${suffix}`;
}

function templateAppliesToDate(template: ClassTemplate, date: Date) {
  const dateKey = formatScheduleDateKey(date);
  return (
    template.is_active &&
    template.day_of_week === date.getDay() &&
    template.start_date <= dateKey &&
    (!template.end_date || template.end_date >= dateKey)
  );
}

function getSessionButtonLabel(session: ClassSession) {
  return `Open ${session.name} at ${formatTime(session.start_time)}`;
}

function formatCanvasHour(minute: number) {
  const hour = Math.floor(minute / 60) % 24;
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return `${hour > 12 ? hour - 12 : hour} ${hour >= 12 ? "PM" : "AM"}`;
}

export function SchedulePageSection({
  canManageSchedule,
  currentDate,
  view,
  programFilter,
  sessions,
  templates,
  programs,
  scheduleLoadError,
  actionMessage,
  onNavigate,
  onJumpToToday,
  onViewChange,
  onProgramFilterChange,
  onDismissScheduleLoadError,
  onDismissActionMessage,
  onSelectDate,
  onOpenSession,
  onOpenAddClass,
}: SchedulePageSectionProps) {
  const today = formatScheduleDateKey(new Date());
  const weekDates = useMemo(() => getScheduleWeekDates(currentDate), [currentDate]);
  const activePrograms = useMemo(
    () => programs.filter((program) => !program.archived_at),
    [programs]
  );
  const programById = useMemo(
    () => new Map(programs.map((program) => [program.id, program])),
    [programs]
  );
  const filteredSessions = useMemo(
    () =>
      programFilter
        ? sessions.filter((session) => session.program_id === programFilter)
        : sessions,
    [programFilter, sessions]
  );
  const filteredTemplates = useMemo(
    () =>
      programFilter
        ? templates.filter((template) => template.program_id === programFilter)
        : templates,
    [programFilter, templates]
  );

  const sessionsByDate = useMemo(() => {
    const grouped: Record<string, ClassSession[]> = {};
    filteredSessions.forEach((session) => {
      if (!grouped[session.date]) {
        grouped[session.date] = [];
      }
      grouped[session.date].push(session);
    });
    return grouped;
  }, [filteredSessions]);

  const templatesByDay = useMemo(() => {
    const grouped: Record<number, ClassTemplate[]> = {};
    filteredTemplates.forEach((template) => {
      if (!grouped[template.day_of_week]) {
        grouped[template.day_of_week] = [];
      }
      grouped[template.day_of_week].push(template);
    });
    return grouped;
  }, [filteredTemplates]);

  const daySessionList = sessionsByDate[formatScheduleDateKey(currentDate)] || [];
  const entriesByDate = useMemo(() => {
    const grouped: Record<string, TimeCanvasEntry[]> = {};
    const dates = view === "day" ? [currentDate] : weekDates;
    dates.forEach((date) => {
      const key = formatScheduleDateKey(date);
      const daySessions = sessionsByDate[key] || [];
      const dayTemplates = (templatesByDay[date.getDay()] || []).filter((template) =>
        templateAppliesToDate(template, date)
      );
      grouped[key] = daySessions.map((session) => ({
        id: session.id,
        kind: "session" as const,
        start_time: session.start_time,
        end_time: session.end_time,
        session,
      }));
      if (daySessions.length === 0) {
        grouped[key].push(...dayTemplates.map((template) => ({
          id: template.id,
          kind: "template" as const,
          start_time: template.start_time,
          end_time: template.end_time,
          template,
        })));
      }
    });
    return grouped;
  }, [currentDate, sessionsByDate, templatesByDay, view, weekDates]);
  const canvasBounds = useMemo(
    () => getScheduleTimeCanvasBounds(Object.values(entriesByDate).flat()),
    [entriesByDate]
  );
  const canvasHourMarks = useMemo(
    () => Array.from(
      { length: Math.floor((canvasBounds.endMinute - canvasBounds.startMinute) / 60) + 1 },
      (_, index) => canvasBounds.startMinute + index * 60
    ),
    [canvasBounds.endMinute, canvasBounds.startMinute]
  );
  const canvasHeight = ((canvasBounds.endMinute - canvasBounds.startMinute) / 60) * SCHEDULE_CANVAS_PIXELS_PER_HOUR;
  const peakWeekLaneCount = useMemo(
    () => weekDates.reduce((peak, date) => {
      const key = formatScheduleDateKey(date);
      const blocks = layoutScheduleTimeItems(entriesByDate[key] || []);
      return blocks.reduce((dayPeak, block) => Math.max(dayPeak, block.laneCount), peak);
    }, 1),
    [entriesByDate, weekDates]
  );
  const weekDayMinWidth = peakWeekLaneCount * SESSION_LANE_MIN_WIDTH;
  const weekCanvasMinWidth = Math.max(
    WEEK_CANVAS_MIN_WIDTH,
    WEEK_TIME_COLUMN_WIDTH + WEEK_DAY_COUNT * weekDayMinWidth
  );
  const weekGridTemplateColumns = `${WEEK_TIME_COLUMN_WIDTH}px repeat(${WEEK_DAY_COUNT}, minmax(${weekDayMinWidth}px, 1fr))`;

  function renderTimeColumn(date: Date, compact: boolean) {
    const key = formatScheduleDateKey(date);
    const blocks = layoutScheduleTimeItems(entriesByDate[key] || []);
    return (
      <div
        className="relative border-r border-border last:border-r-0"
        style={{ height: canvasHeight }}
        data-time-canvas-day={key}
      >
        {canvasHourMarks.map((minute) => (
          <span
            key={minute}
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 border-t border-border/60"
            style={{ top: ((minute - canvasBounds.startMinute) / 60) * SCHEDULE_CANVAS_PIXELS_PER_HOUR }}
          />
        ))}
        {blocks.map((block) => {
          const top = ((block.startMinute - canvasBounds.startMinute) / 60) * SCHEDULE_CANVAS_PIXELS_PER_HOUR;
          const height = ((block.endMinute - block.startMinute) / 60) * SCHEDULE_CANVAS_PIXELS_PER_HOUR;
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
                className="absolute overflow-hidden rounded-[8px] border border-dashed border-border bg-surface-raised px-2 py-1 text-left text-[10px] text-muted"
                style={{ top, height, left: `calc(${left}% + 2px)`, width: `calc(${laneWidth}% - 4px)` }}
                data-time-canvas-block="template"
                data-time-canvas-visible={`${entry.kind}:${entry.id}`}
              >
                <strong className="block truncate font-medium">{title}</strong>
                <span>{formatTime(entry.start_time)} · recurring</span>
              </div>
            );
          }

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
                const visibleElement = document.elementsFromPoint(event.clientX, event.clientY).find(
                  (element): element is HTMLElement =>
                    element instanceof HTMLElement &&
                    Boolean(element.dataset.timeCanvasVisible) &&
                    Boolean(canvas?.contains(element)) &&
                    isPointWithinTimeCanvasFootprint(
                      element.getBoundingClientRect(),
                      event.clientX,
                      event.clientY
                    )
                );
                const visibleBlock = visibleElement
                  ? blocks.find(
                      (candidate) =>
                        `${candidate.item.kind}:${candidate.item.id}` === visibleElement.dataset.timeCanvasVisible
                    )
                  : undefined;
                if (visibleBlock) {
                  if (visibleBlock.item.session) onOpenSession(visibleBlock.item.session);
                  return;
                }
                onOpenSession(session);
              }}
              aria-label={getSessionButtonLabel(session)}
              className="absolute min-h-11 min-w-11 text-left"
              style={{
                top: targetTop,
                height: targetHeight,
                left: sessionLeft,
                width: sessionWidth,
                "--program-color": program?.color_hex || "var(--operations-cobalt)",
              } as CSSProperties}
              data-time-canvas-block="session"
              data-overlap={block.overlaps ? "true" : "false"}
            >
              <span
                aria-hidden="true"
                className="absolute inset-x-0 overflow-hidden border border-border bg-surface px-2 py-1 hover:border-accent"
                style={{ height, top: top - targetTop }}
                data-time-canvas-visible={`${entry.kind}:${entry.id}`}
              >
                <strong className="block truncate text-[11px] font-semibold text-text-primary">{title}</strong>
                <span className="block truncate text-[10px] tabular-nums text-text-secondary">
                  {formatTime(entry.start_time)}–{formatTime(entry.end_time)}
                </span>
                {!compact && program ? <span className="block truncate text-[10px] text-muted">{program.name}</span> : null}
              </span>
            </button>
          );
        })}
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

  return (
    <>
      <Header title="Schedule">
        {canManageSchedule ? (
          <Button
            variant="primary"
            size="sm"
            onClick={onOpenAddClass}
          >
            <Plus aria-hidden="true" className="w-3.5 h-3.5" />
            Add class
          </Button>
        ) : null}
      </Header>

      <div className="flex flex-1 flex-col" data-schedule-day-sheet="true">
      <section
        className="grid gap-2 bg-surface p-2 sm:grid-cols-[1.25fr_0.75fr_0.75fr_1fr]"
        aria-label="Visible schedule range"
        data-schedule-register="visible-range"
      >
        <div className="rounded-[10px] bg-surface-raised px-4 py-3">
          <p className="text-xs font-medium text-muted">Visible range</p>
          <p className="mt-1 text-sm font-semibold text-text-primary">{getToolbarLabel()}</p>
        </div>
        <div className="rounded-[10px] bg-surface-raised px-4 py-3">
          <p className="text-xs font-medium text-muted">Scheduled</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-text-primary">{filteredSessions.length}</p>
        </div>
        <div className="rounded-[10px] bg-surface-raised px-4 py-3">
          <p className="text-xs font-medium text-muted">Recurring slots</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-text-primary">{filteredTemplates.length}</p>
        </div>
        <div className="rounded-[10px] bg-surface-raised px-4 py-3">
          <p className="text-xs font-medium text-muted">Program scope</p>
          <p className="mt-1 text-sm text-text-primary">
            {programFilter ? programById.get(programFilter)?.name || "Selected program" : "All programs"}
          </p>
        </div>
      </section>
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8 lg:py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Schedule date navigation">
          <button
            type="button"
            onClick={() => onNavigate(-1)}
            aria-label={`Previous ${view}`}
            className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-[10px] text-text-secondary transition-colors hover:bg-surface-raised"
          >
            <ChevronLeft aria-hidden="true" className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onJumpToToday}
            aria-label="Jump to today"
            className="min-h-11 cursor-pointer rounded-[10px] px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => onNavigate(1)}
            aria-label={`Next ${view}`}
            className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-[10px] text-text-secondary transition-colors hover:bg-surface-raised"
          >
            <ChevronRight aria-hidden="true" className="w-4 h-4" />
          </button>
          <span className="w-full min-w-0 break-words pt-1 text-sm font-semibold tracking-tight text-text-primary sm:ml-3 sm:w-auto sm:pt-0">
            {getToolbarLabel()}
          </span>
        </div>

        <SlidingSegmentedControl
          activeValue={view}
          ariaLabel="Schedule view"
          className="w-full sm:w-auto sm:min-w-56"
          items={SCHEDULE_VIEWS.map((nextView) => ({
            id: nextView,
            label: nextView[0].toUpperCase() + nextView.slice(1),
          }))}
          onChange={onViewChange}
          size="compact"
        />
      </div>

      <div className="flex flex-col items-stretch gap-3 border-b border-border px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-6 lg:px-8">
        <select
          value={programFilter}
          onChange={(event) => onProgramFilterChange(event.target.value)}
          aria-label="Filter schedule by program"
          data-schedule-program-filter={programFilter ? "selected" : "all"}
          className="min-h-11 w-full border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none sm:w-auto"
        >
          <option value="">All programs</option>
          {activePrograms.map((program) => (
            <option key={program.id} value={program.id}>
              {program.name}
            </option>
          ))}
        </select>
        {programFilter ? (
          <ProgramBadge program={programById.get(programFilter)} />
        ) : (
          <span className="break-words text-xs text-muted">Showing classes from every program</span>
        )}
      </div>

      {scheduleLoadError ? (
        <div className="px-6 sm:px-8 pt-4">
          <DismissibleNotice tone="danger" onDismiss={onDismissScheduleLoadError}>
            {scheduleLoadError}
          </DismissibleNotice>
        </div>
      ) : null}

      {actionMessage ? (
        <div className="px-6 sm:px-8 pt-4">
          <DismissibleNotice tone="success" onDismiss={onDismissActionMessage}>
            {actionMessage}
          </DismissibleNotice>
        </div>
      ) : null}

      {view === "month" && (
        <div className="flex-1 p-3 sm:p-6">
          <MonthScheduleView
            month={currentDate}
            sessions={filteredSessions}
            templates={filteredTemplates}
            selectedDate={currentDate}
            today={new Date()}
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

      {view === "week" && (
        <>
          <div
            className="flex-1 overflow-x-auto overscroll-x-contain"
            data-schedule-screen-week="true"
            data-schedule-scroll-owner="internal"
            role="region"
            tabIndex={0}
            aria-label="Scrollable weekly time canvas"
          >
            <div
              className="overflow-hidden bg-surface"
              style={{ minWidth: weekCanvasMinWidth }}
              data-schedule-time-canvas="week"
              data-schedule-week-peak-lanes={peakWeekLaneCount}
            >
              <div className="grid border-b border-border" style={{ gridTemplateColumns: weekGridTemplateColumns }}>
                <div className="border-r border-border px-2 py-3 text-xs text-muted">Studio time</div>
                {weekDates.map((date) => {
                  const key = formatScheduleDateKey(date);
                  const isToday = key === today;
                  return (
                    <div key={key} className={`relative border-r border-border px-2 py-3 text-center last:border-r-0 ${isToday ? "bg-accent/10" : ""}`}>
                      <p className="text-xs text-muted">{DAY_NAMES[date.getDay()]}</p>
                      <p className={`mt-1 text-base tabular-nums ${isToday ? "font-semibold text-accent" : "text-text-primary"}`}>{date.getDate()}</p>
                    </div>
                  );
                })}
              </div>
              <div className="grid" style={{ gridTemplateColumns: weekGridTemplateColumns }}>
                <div className="relative border-r border-border" style={{ height: canvasHeight }} aria-hidden="true">
                  {canvasHourMarks.map((minute) => (
                    <span
                      key={minute}
                      className="absolute right-2 -translate-y-1/2 text-[9px] tabular-nums text-muted"
                      style={{ top: ((minute - canvasBounds.startMinute) / 60) * SCHEDULE_CANVAS_PIXELS_PER_HOUR }}
                    >
                      {formatCanvasHour(minute)}
                    </span>
                  ))}
                </div>
                {weekDates.map((date) => <div key={formatScheduleDateKey(date)}>{renderTimeColumn(date, true)}</div>)}
              </div>
            </div>
          </div>

          <section data-schedule-print-week="true" aria-label="Weekly schedule">
            {weekDates.map((date) => {
              const key = formatScheduleDateKey(date);
              const entries = layoutScheduleTimeItems(entriesByDate[key] || []).map((block) => block.item);
              return (
                <section key={key} data-schedule-print-day={key}>
                  <header data-schedule-print-day-header="true">
                    <strong>{DAY_NAMES[date.getDay()]} {date.getDate()}</strong>
                  </header>
                  {entries.length === 0 ? <p data-schedule-print-empty="true">No sessions scheduled.</p> : null}
                  {entries.map((entry) => {
                    const programId = entry.session?.program_id || entry.template?.program_id || null;
                    const program = programId ? programById.get(programId) : null;
                    return (
                      <article key={`${entry.kind}-${entry.id}`} data-schedule-print-entry={entry.kind}>
                        <span>{formatTime(entry.start_time)}–{formatTime(entry.end_time)}</span>
                        <strong>{entry.session?.name || entry.template?.name || "Class"}</strong>
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

      {view === "day" && (
        <div className="flex-1 px-3 py-6 sm:px-8">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {currentDate.toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </h2>
          <p className="text-xs text-muted">Classes are placed by start time and duration. Overlaps share the same time lane.</p>
          </div>

          {daySessionList.length === 0 ? (
            <div className="rounded-[14px] bg-surface py-16 text-center shadow-[var(--product-shadow-card)]">
              <Calendar aria-hidden="true" className="w-5 h-5 text-muted mx-auto mb-3" />
              <p className="text-sm text-text-secondary">No sessions scheduled for this day.</p>
              {canManageSchedule ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-5"
                  onClick={onOpenAddClass}
                >
                  <Plus aria-hidden="true" className="w-3.5 h-3.5" />
                  Add class
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] border-y border-border bg-surface" data-schedule-time-canvas="day">
              <div className="relative border-r border-border" style={{ height: canvasHeight }} aria-hidden="true">
                {canvasHourMarks.map((minute) => (
                  <span
                    key={minute}
                    className="absolute right-2 -translate-y-1/2 text-[9px] tabular-nums text-muted"
                    style={{ top: ((minute - canvasBounds.startMinute) / 60) * SCHEDULE_CANVAS_PIXELS_PER_HOUR }}
                  >
                    {formatCanvasHour(minute)}
                  </span>
                ))}
              </div>
              {renderTimeColumn(currentDate, false)}
            </div>
          )}
        </div>
      )}
      </div>
    </>
  );
}
