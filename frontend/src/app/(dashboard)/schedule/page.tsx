"use client";

import { useEffect, useMemo, useState } from "react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { toLocalDateKey } from "@/lib/date";
import { useProgramStore, useScheduleStore, useStudentStore } from "@/lib/store";
import type { ClassSession, ClassTemplate } from "@/types";
import { ClassFormModal, type ClassFormSubmitPayload } from "@/components/schedule/class-form-modal";
import { MonthScheduleView } from "@/components/schedule/month-schedule-view";
import { ProgramBadge } from "@/components/programs/program-picker";
import {
  ScheduleSessionDetailModal,
  type ScheduleSessionDeleteScope,
} from "@/components/schedule/session-detail-modal";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Plus,
  Users,
} from "lucide-react";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatTime(value: string) {
  const [hoursText = "0", minutes = "00"] = value.split(":");
  const hours = Number(hoursText);
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${hour12}:${minutes.slice(0, 2)} ${suffix}`;
}

function dateStr(date: Date) {
  return toLocalDateKey(date);
}

function getWeekDates(base: Date): Date[] {
  const start = new Date(base);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(start);
    current.setDate(start.getDate() + index);
    return current;
  });
}

function getMonthGridRange(base: Date) {
  const firstOfMonth = new Date(base.getFullYear(), base.getMonth(), 1, 12);
  const start = new Date(firstOfMonth);
  start.setDate(firstOfMonth.getDate() - firstOfMonth.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 41);
  return { start, end };
}

function templateAppliesToDate(template: ClassTemplate, date: Date) {
  const dateKey = dateStr(date);
  return (
    template.is_active &&
    template.day_of_week === date.getDay() &&
    template.start_date <= dateKey &&
    (!template.end_date || template.end_date >= dateKey)
  );
}

type View = "month" | "week" | "day";

export default function SchedulePage() {
  const { students } = useStudentStore();
  const { programs } = useProgramStore();
  const {
    attendance,
    sessions,
    templates,
    addSession,
    addTemplate,
    deleteSession,
    refreshScheduleRange,
    refreshSessionAttendance,
    toggleCheckIn,
  } = useScheduleStore();

  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<View>("week");
  const [programFilter, setProgramFilter] = useState("");
  const [selectedSession, setSelectedSession] = useState<ClassSession | null>(null);
  const [showAddClass, setShowAddClass] = useState(false);
  const [isCreatingClass, setIsCreatingClass] = useState(false);
  const [createClassError, setCreateClassError] = useState<string | null>(null);
  const [scheduleLoadError, setScheduleLoadError] = useState<string | null>(null);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);
  const [pendingAttendanceId, setPendingAttendanceId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState<ScheduleSessionDeleteScope | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const visibleRange = useMemo(() => {
    if (view === "day") {
      const key = dateStr(currentDate);
      return { start: key, end: key };
    }

    if (view === "month") {
      const { start, end } = getMonthGridRange(currentDate);
      return { start: dateStr(start), end: dateStr(end) };
    }

    const weekDates = getWeekDates(currentDate);
    return {
      start: dateStr(weekDates[0]),
      end: dateStr(weekDates[6]),
    };
  }, [currentDate, view]);

  useEffect(() => {
    let cancelled = false;

    async function loadRange() {
      setScheduleLoadError(null);
      try {
        await refreshScheduleRange(visibleRange.start, visibleRange.end);
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load schedule range", error);
          setScheduleLoadError("Could not load this calendar range. Please try again.");
        }
      }
    }

    void loadRange();

    return () => {
      cancelled = true;
    };
  }, [refreshScheduleRange, visibleRange.end, visibleRange.start]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    void refreshSessionAttendance(selectedSession.id).catch((error) => {
      console.error("Failed to load session attendance", error);
    });
  }, [refreshSessionAttendance, selectedSession]);

  const today = dateStr(new Date());
  const weekDates = useMemo(() => getWeekDates(currentDate), [currentDate]);
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

  const activeStudents = useMemo(
    () => students.filter((student) => student.status === "active" || student.status === "trialing"),
    [students]
  );

  function getSessionAttendance(sessionId: string) {
    return attendance.filter((record) => record.session_id === sessionId);
  }

  function navigate(dir: number) {
    const next = new Date(currentDate);
    if (view === "day") {
      next.setDate(next.getDate() + dir);
    } else if (view === "month") {
      next.setMonth(next.getMonth() + dir);
    } else {
      next.setDate(next.getDate() + dir * 7);
    }
    setCurrentDate(next);
  }

  function jumpToToday() {
    setCurrentDate(new Date());
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
    })} – ${weekDates[6].toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })}`;
  }

  async function handleCreateClass(payload: ClassFormSubmitPayload) {
    setCreateClassError(null);
    setIsCreatingClass(true);

    try {
      if (payload.kind === "single_session") {
        await addSession({
          name: payload.name,
          date: payload.sessionDate,
          start_time: payload.startTime,
          end_time: payload.endTime,
          program_id: payload.program_id,
          capacity: payload.capacity,
        });
      } else {
        await addTemplate({
          name: payload.name,
          day_of_week: payload.recurrence.dayOfWeek,
          start_time: payload.startTime,
          end_time: payload.endTime,
          start_date: payload.recurrence.startDate,
          end_date: payload.recurrence.endDate,
          program_id: payload.program_id,
          capacity: payload.capacity,
        });

        const overlapsVisibleRange =
          payload.recurrence.startDate <= visibleRange.end &&
          (!payload.recurrence.endDate || payload.recurrence.endDate >= visibleRange.start);

        if (overlapsVisibleRange) {
          await refreshScheduleRange(visibleRange.start, visibleRange.end);
        }
      }
      setShowAddClass(false);
      setActionMessage(
        payload.kind === "single_session"
          ? "Class added to the schedule."
          : "Recurring class created and visible sessions refreshed."
      );
    } catch (error) {
      console.error("Failed to create class", error);
      setCreateClassError(
        error instanceof Error ? error.message : "Could not create this class. Please try again."
      );
    } finally {
      setIsCreatingClass(false);
    }
  }

  async function handleToggleAttendance(sessionId: string, studentId: string, name: string) {
    setAttendanceError(null);
    setPendingAttendanceId(studentId);
    try {
      await toggleCheckIn(sessionId, studentId, name);
    } catch (error) {
      console.error("Failed to update attendance", error);
      setAttendanceError("Could not update attendance. Please try again.");
    } finally {
      setPendingAttendanceId(null);
    }
  }

  async function handleDeleteSelectedSession(scope: ScheduleSessionDeleteScope) {
    if (!selectedSession) {
      return;
    }

    setDeleteError(null);
    setDeleteInFlight(scope);

    try {
      await deleteSession(
        selectedSession.id,
        scope === "series" ? "future_series" : "session"
      );
      setSelectedSession(null);
      setActionMessage(scope === "series" ? "Recurring class series removed." : "Class removed from the schedule.");
    } catch (error) {
      console.error("Failed to delete session", error);
      setDeleteError(
        error instanceof Error ? error.message : "Could not delete this class. Please try again."
      );
    } finally {
      setDeleteInFlight(null);
    }
  }

  const daySessionList = sessionsByDate[dateStr(currentDate)] || [];

  return (
    <>
      <Header title="Schedule" description="Class schedule and attendance.">
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setCreateClassError(null);
            setShowAddClass(true);
          }}
        >
          <Plus className="w-3.5 h-3.5" />
          Add class
        </Button>
      </Header>

      <div className="flex-1 flex flex-col">
        {/* ── Toolbar ── */}
        <div className="flex items-center justify-between px-6 sm:px-8 py-4 border-b border-border">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => navigate(-1)}
              className="p-1.5 hover:bg-surface-raised text-text-secondary transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={jumpToToday}
              className="px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10 transition-colors cursor-pointer"
            >
              Today
            </button>
            <button
              onClick={() => navigate(1)}
              className="p-1.5 hover:bg-surface-raised text-text-secondary transition-colors cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="text-sm text-text-primary ml-3 font-semibold tracking-tight">
              {getToolbarLabel()}
            </span>
          </div>

          <div className="flex items-center bg-surface border border-border p-0.5">
            {(["month", "week", "day"] as View[]).map((nextView) => (
              <button
                key={nextView}
                onClick={() => setView(nextView)}
                className={`px-3 py-1 text-xs capitalize cursor-pointer transition-colors ${
                  view === nextView
                    ? "bg-accent text-[#0B0D10] font-medium"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {nextView}
              </button>
            ))}
          </div>
        </div>

        {/* ── Program filter ── */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 sm:px-8 py-3">
          <select
            value={programFilter}
            onChange={(event) => setProgramFilter(event.target.value)}
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

        {/* ── Notices ── */}
        {scheduleLoadError ? (
          <div className="px-6 sm:px-8 pt-4">
            <DismissibleNotice tone="danger" onDismiss={() => setScheduleLoadError(null)}>
              {scheduleLoadError}
            </DismissibleNotice>
          </div>
        ) : null}

        {actionMessage ? (
          <div className="px-6 sm:px-8 pt-4">
            <DismissibleNotice tone="success" onDismiss={() => setActionMessage(null)}>
              {actionMessage}
            </DismissibleNotice>
          </div>
        ) : null}

        {/* ── Month View ── */}
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
              onDayClick={(date) => setCurrentDate(date)}
              onEntryClick={(entry) => {
                if (entry.kind === "session") {
                  setAttendanceError(null);
                  setDeleteError(null);
                  setSelectedSession(entry.session);
                }
              }}
              onMoreClick={(date) => {
                setCurrentDate(date);
                setView("day");
              }}
            />
          </div>
        )}

        {/* ── Week View ── */}
        {view === "week" && (
          <div className="flex-1 overflow-x-auto">
            <div className="grid grid-cols-7 min-w-[980px]">
              {/* Day headers */}
              {weekDates.map((date) => {
                const key = dateStr(date);
                const isToday = key === today;
                return (
                  <div
                    key={`header-${key}`}
                    className={`relative px-3 py-3 text-center border-b border-r border-border last:border-r-0 ${
                      isToday ? "bg-accent/[0.04]" : ""
                    }`}
                  >
                    {/* Today accent line */}
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

              {/* Day cells */}
              {weekDates.map((date) => {
                const key = dateStr(date);
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
                          onClick={() => {
                            setAttendanceError(null);
                            setDeleteError(null);
                            setSelectedSession(session);
                          }}
                          className="group relative w-full text-left mb-2 bg-surface-raised border border-border hover:border-[color:var(--accent)]/40 transition-colors cursor-pointer overflow-hidden"
                        >
                          {/* Program color accent bar */}
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
                                <Users className="w-2.5 h-2.5 text-muted" />
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
                        <span className="text-[10px] text-muted/40 uppercase tracking-widest">—</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Day View ── */}
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
                <Calendar className="w-5 h-5 text-muted mx-auto mb-3" />
                <p className="text-sm text-text-secondary">No sessions scheduled for this day.</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-5"
                  onClick={() => {
                    setCreateClassError(null);
                    setShowAddClass(true);
                  }}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add class
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {daySessionList.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => {
                      setAttendanceError(null);
                      setDeleteError(null);
                      setSelectedSession(session);
                    }}
                    className="group relative w-full text-left p-5 bg-surface border border-border hover:border-[color:var(--accent)]/30 transition-colors cursor-pointer"
                  >
                    {/* Accent top edge on hover */}
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
                          {formatTime(session.start_time)} – {formatTime(session.end_time)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 text-text-secondary shrink-0">
                        <Users className="w-3.5 h-3.5" />
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

      <ScheduleSessionDetailModal
        open={Boolean(selectedSession)}
        session={selectedSession}
        students={activeStudents}
        programs={programs}
        attendance={selectedSession ? getSessionAttendance(selectedSession.id) : []}
        attendanceError={attendanceError}
        onDismissAttendanceError={() => setAttendanceError(null)}
        pendingAttendanceStudentId={pendingAttendanceId}
        deleteError={deleteError}
        deleteInFlight={deleteInFlight}
        onClose={() => {
          setAttendanceError(null);
          setDeleteError(null);
          setSelectedSession(null);
        }}
        onToggleAttendance={handleToggleAttendance}
        onDeleteSession={async () => {
          await handleDeleteSelectedSession("session");
        }}
        onDeleteSeries={
          selectedSession?.template_id
            ? async () => {
                await handleDeleteSelectedSession("series");
              }
            : undefined
        }
      />

      <ClassFormModal
        open={showAddClass}
        onClose={() => {
          if (!isCreatingClass) {
            setShowAddClass(false);
          }
        }}
        isLoading={isCreatingClass}
        error={createClassError}
        onDismissError={() => setCreateClassError(null)}
        title="Add class"
        defaultMode="weekly"
        programs={programs}
        onSubmit={handleCreateClass}
      />
    </>
  );
}
