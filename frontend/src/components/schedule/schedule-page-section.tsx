"use client";

import { useMemo } from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Plus,
  Users,
} from "lucide-react";

import { ProgramBadge } from "@/components/programs/program-picker";
import { Header } from "@/components/header";
import { MonthScheduleView } from "@/components/schedule/month-schedule-view";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import {
  formatScheduleDateKey,
  getScheduleWeekDates,
  type SchedulePageView,
} from "@/lib/schedule-page-model";
import type { ClassSession, ClassTemplate, Program } from "@/types";

interface SchedulePageSectionProps {
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

export function SchedulePageSection({
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
      <Header title="Schedule" description="Class schedule and attendance.">
        <Button
          variant="primary"
          size="sm"
          onClick={onOpenAddClass}
        >
          <Plus aria-hidden="true" className="w-3.5 h-3.5" />
          Add class
        </Button>
      </Header>

      <div className="flex-1 flex flex-col">
      <div className="flex items-center justify-between px-6 sm:px-8 py-4 border-b border-border">
        <div className="flex items-center gap-1.5" role="group" aria-label="Schedule date navigation">
          <button
            type="button"
            onClick={() => onNavigate(-1)}
            aria-label={`Previous ${view}`}
            className="p-1.5 hover:bg-surface-raised text-text-secondary transition-colors cursor-pointer"
          >
            <ChevronLeft aria-hidden="true" className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onJumpToToday}
            aria-label="Jump to today"
            className="px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10 transition-colors cursor-pointer"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => onNavigate(1)}
            aria-label={`Next ${view}`}
            className="p-1.5 hover:bg-surface-raised text-text-secondary transition-colors cursor-pointer"
          >
            <ChevronRight aria-hidden="true" className="w-4 h-4" />
          </button>
          <span className="text-sm text-text-primary ml-3 font-semibold tracking-tight">
            {getToolbarLabel()}
          </span>
        </div>

        <div className="flex items-center bg-surface border border-border p-0.5" role="group" aria-label="Schedule view">
          {SCHEDULE_VIEWS.map((nextView) => (
            <button
              key={nextView}
              type="button"
              onClick={() => onViewChange(nextView)}
              aria-pressed={view === nextView}
              aria-label={`Show ${nextView} schedule view`}
              className={`px-3 py-1 text-xs capitalize cursor-pointer transition-colors ${
                view === nextView
                  ? "bg-accent text-accent-contrast font-medium"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {nextView}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 sm:px-8 py-3">
        <select
          value={programFilter}
          onChange={(event) => onProgramFilterChange(event.target.value)}
          aria-label="Filter schedule by program"
          className="px-3 py-1.5 text-sm bg-surface-raised border border-border text-text-primary focus:border-accent focus:outline-none"
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
          <span className="text-xs text-muted">Showing classes from every program</span>
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
        <div className="flex-1 p-6">
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
        <div className="flex-1 overflow-x-auto">
          <div className="grid grid-cols-7 min-w-[980px]">
            {weekDates.map((date) => {
              const key = formatScheduleDateKey(date);
              const isToday = key === today;
              return (
                <div
                  key={`header-${key}`}
                  className={`relative px-3 py-3 text-center border-b border-r border-border last:border-r-0 ${
                    isToday ? "bg-accent/[0.04]" : ""
                  }`}
                >
                  {isToday && (
                    <span className="absolute top-0 left-0 right-0 h-[2px] bg-accent" />
                  )}
                  <p className="text-[11px] text-muted uppercase tracking-widest">{DAY_NAMES[date.getDay()]}</p>
                  <p className={`text-lg font-mono mt-0.5 ${isToday ? "text-accent font-bold" : "text-text-primary"}`}>
                    {date.getDate()}
                  </p>
                </div>
              );
            })}

            {weekDates.map((date) => {
              const key = formatScheduleDateKey(date);
              const isToday = key === today;
              const daySessions = sessionsByDate[key] || [];
              const dayTemplates = (templatesByDay[date.getDay()] || []).filter((template) =>
                templateAppliesToDate(template, date)
              );
              const isEmpty = daySessions.length === 0 && dayTemplates.length === 0;

              return (
                <div
                  key={`cell-${key}`}
                  className={`min-h-[180px] border-r border-b border-border p-2 last:border-r-0 ${
                    isToday ? "bg-accent/[0.02]" : ""
                  }`}
                >
                  {daySessions.map((session) => {
                    const program = session.program_id ? programById.get(session.program_id) : null;
                    const accentColor = program?.color_hex || "var(--border)";

                    return (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => onOpenSession(session)}
                        aria-label={getSessionButtonLabel(session)}
                        className="group relative w-full text-left mb-2 bg-surface-raised border border-border hover:border-[color:var(--accent)]/40 transition-colors cursor-pointer overflow-hidden"
                      >
                        <span
                          className="absolute left-0 top-0 bottom-0 w-[3px]"
                          style={{ backgroundColor: accentColor }}
                        />

                        <div className="pl-3 pr-2.5 py-2.5">
                          <p className="text-xs font-semibold text-text-primary truncate leading-tight">
                            {session.name}
                          </p>
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className="text-[10px] text-muted font-mono leading-none">
                              {formatTime(session.start_time)}
                            </span>
                            {program && (
                              <span className="text-[10px] text-text-secondary truncate leading-none">
                                {program.name}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-border/50">
                            {session.capacity ? (
                              <span className="text-[10px] text-muted">
                                Cap {session.capacity}
                              </span>
                            ) : (
                              <span />
                            )}
                            <span className="text-[10px] text-text-secondary font-mono flex items-center gap-1">
                              <Users aria-hidden="true" className="w-2.5 h-2.5 text-muted" />
                              {session.attendance_count}
                              {session.capacity ? `/${session.capacity}` : ""}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}

                  {daySessions.length === 0 && dayTemplates.length > 0 && (
                    dayTemplates.map((template) => {
                      const program = template.program_id ? programById.get(template.program_id) : null;

                      return (
                        <div
                          key={template.id}
                          className="relative w-full mb-2 border border-dashed border-border/60 opacity-60 overflow-hidden"
                        >
                          <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-border/40" />
                          <div className="pl-3 pr-2.5 py-2">
                            <p className="text-xs text-muted truncate">{template.name}</p>
                            <div className="mt-1 flex items-center gap-1.5">
                              <span className="text-[10px] text-muted font-mono">{formatTime(template.start_time)}</span>
                              {program && (
                                <span className="text-[10px] text-muted truncate">{program.name}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}

                  {isEmpty && (
                    <div className="flex items-center justify-center h-full min-h-[60px]">
                      <span className="text-[10px] text-muted/40 uppercase tracking-widest">&mdash;</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === "day" && (
        <div className="flex-1 p-6 sm:p-8">
          <h2 className="text-sm font-semibold text-text-primary mb-5">
            {currentDate.toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </h2>

          {daySessionList.length === 0 ? (
            <div className="text-center py-16 border border-border bg-surface">
              <Calendar aria-hidden="true" className="w-5 h-5 text-muted mx-auto mb-3" />
              <p className="text-sm text-text-secondary">No sessions scheduled for this day.</p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-5"
                onClick={onOpenAddClass}
              >
                <Plus aria-hidden="true" className="w-3.5 h-3.5" />
                Add class
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {daySessionList.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onOpenSession(session)}
                  aria-label={getSessionButtonLabel(session)}
                  className="group relative w-full text-left p-5 bg-surface border border-border hover:border-[color:var(--accent)]/30 transition-colors cursor-pointer"
                >
                  <span className="absolute top-0 left-0 right-0 h-[2px] bg-accent opacity-0 group-hover:opacity-100 transition-opacity duration-150" />

                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-text-primary">{session.name}</p>
                        {session.program_id ? (
                          <ProgramBadge program={programById.get(session.program_id)} />
                        ) : null}
                      </div>
                      <p className="text-xs text-muted font-mono mt-1.5">
                        {formatTime(session.start_time)} &ndash; {formatTime(session.end_time)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-text-secondary shrink-0">
                      <Users aria-hidden="true" className="w-3.5 h-3.5" />
                      <span className="text-sm font-mono">
                        {session.attendance_count}
                        {session.capacity ? `/${session.capacity}` : ""}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </>
  );
}
