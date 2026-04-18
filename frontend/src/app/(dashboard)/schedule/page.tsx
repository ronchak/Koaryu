"use client";

import { useState, useMemo } from "react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { MOCK_SESSIONS, MOCK_CLASS_TEMPLATES, MOCK_ATTENDANCE, MOCK_STUDENTS } from "@/lib/mock-data";
import type { ClassSession, AttendanceRecord, AttendanceStatus } from "@/types";
import {
  Calendar,
  Clock,
  Users,
  ChevronLeft,
  ChevronRight,
  Plus,
  Check,
  X,
  AlertCircle,
} from "lucide-react";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatTime(t: string) {
  const [h, m] = t.split(":");
  const hour = parseInt(h);
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${m} ${ampm}`;
}

function getWeekDates(base: Date): Date[] {
  const start = new Date(base);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function dateStr(d: Date) {
  return d.toISOString().split("T")[0];
}

type View = "week" | "day";

const STATUS_ICON: Record<AttendanceStatus, React.ReactNode> = {
  present: <Check className="w-3 h-3 text-success" />,
  late: <Clock className="w-3 h-3 text-warning" />,
  excused: <AlertCircle className="w-3 h-3 text-muted" />,
  absent: <X className="w-3 h-3 text-danger" />,
};

export default function SchedulePage() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<View>("week");
  const [sessions] = useState<ClassSession[]>(MOCK_SESSIONS);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>(MOCK_ATTENDANCE);
  const [selectedSession, setSelectedSession] = useState<ClassSession | null>(null);
  const [showAddClass, setShowAddClass] = useState(false);

  const weekDates = useMemo(() => getWeekDates(currentDate), [currentDate]);
  const today = dateStr(new Date());

  // Group sessions by date for week view
  const sessionsByDate = useMemo(() => {
    const map: Record<string, ClassSession[]> = {};
    sessions.forEach((s) => {
      if (!map[s.date]) map[s.date] = [];
      map[s.date].push(s);
    });
    return map;
  }, [sessions]);

  // Group templates by day
  const templatesByDay = useMemo(() => {
    const map: Record<number, typeof MOCK_CLASS_TEMPLATES> = {};
    MOCK_CLASS_TEMPLATES.forEach((t) => {
      if (!map[t.day_of_week]) map[t.day_of_week] = [];
      map[t.day_of_week].push(t);
    });
    return map;
  }, []);

  function navigateWeek(dir: number) {
    const d = new Date(currentDate);
    d.setDate(d.getDate() + dir * 7);
    setCurrentDate(d);
  }

  // Get attendance for a session
  function getSessionAttendance(sessionId: string) {
    return attendance.filter((a) => a.session_id === sessionId);
  }

  // Toggle student check-in
  function toggleCheckIn(sessionId: string, studentId: string, name: string) {
    setAttendance((prev) => {
      const existing = prev.find(
        (a) => a.session_id === sessionId && a.student_id === studentId
      );
      if (existing) {
        // Cycle: present → late → absent → remove
        const cycle: AttendanceStatus[] = ["present", "late", "absent"];
        const idx = cycle.indexOf(existing.status);
        if (idx === cycle.length - 1) {
          return prev.filter((a) => a !== existing);
        }
        return prev.map((a) =>
          a === existing ? { ...a, status: cycle[idx + 1] } : a
        );
      }
      // New check-in
      return [
        ...prev,
        {
          id: `att-${Date.now()}`,
          studio_id: "mock-studio",
          session_id: sessionId,
          student_id: studentId,
          status: "present" as AttendanceStatus,
          checked_in_at: new Date().toISOString(),
          student_name: name,
        },
      ];
    });
  }

  const activeStudents = MOCK_STUDENTS.filter((s) => s.status === "active" || s.status === "trialing");

  return (
    <>
      <Header title="Schedule" description="Class schedule and attendance.">
        <Button variant="primary" size="sm" onClick={() => setShowAddClass(true)}>
          <Plus className="w-3.5 h-3.5" />
          Add class
        </Button>
      </Header>

      <div className="flex-1 flex flex-col">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-8 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigateWeek(-1)}
              className="p-1.5 rounded-[6px] hover:bg-surface-raised text-text-secondary cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setCurrentDate(new Date())}
              className="px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10 rounded-[6px] cursor-pointer"
            >
              Today
            </button>
            <button
              onClick={() => navigateWeek(1)}
              className="p-1.5 rounded-[6px] hover:bg-surface-raised text-text-secondary cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="text-sm text-text-primary ml-2 font-medium">
              {weekDates[0].toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </span>
          </div>

          <div className="flex items-center bg-surface-raised rounded-[6px] border border-border p-0.5">
            {(["week", "day"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 text-xs rounded-[4px] capitalize cursor-pointer transition-colors ${
                  view === v
                    ? "bg-accent text-[#0B0D10] font-medium"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        {/* Week view */}
        {view === "week" && (
          <div className="flex-1 overflow-x-auto">
            <div className="grid grid-cols-7 min-w-[900px]">
              {/* Day headers */}
              {weekDates.map((d, i) => {
                const ds = dateStr(d);
                const isToday = ds === today;
                return (
                  <div
                    key={i}
                    className={`px-3 py-3 text-center border-b border-r border-border ${
                      isToday ? "bg-accent/5" : ""
                    }`}
                  >
                    <p className="text-xs text-muted">{DAY_NAMES[i]}</p>
                    <p
                      className={`text-lg font-mono ${
                        isToday ? "text-accent font-bold" : "text-text-primary"
                      }`}
                    >
                      {d.getDate()}
                    </p>
                  </div>
                );
              })}

              {/* Day cells */}
              {weekDates.map((d, i) => {
                const ds = dateStr(d);
                const isToday = ds === today;
                const daySessions = sessionsByDate[ds] || [];
                const dayTemplates = templatesByDay[d.getDay()] || [];
                // Show sessions if exist, otherwise show templates as upcoming
                const items = daySessions.length > 0 ? daySessions : [];

                return (
                  <div
                    key={`cell-${i}`}
                    className={`min-h-[160px] border-r border-b border-border p-2 ${
                      isToday ? "bg-accent/[0.02]" : ""
                    }`}
                  >
                    {items.map((session) => (
                      <button
                        key={session.id}
                        onClick={() => setSelectedSession(session)}
                        className="w-full text-left mb-1.5 p-2 bg-surface-raised border border-border rounded-[6px] hover:border-accent/50 transition-colors cursor-pointer"
                      >
                        <p className="text-xs font-medium text-text-primary truncate">
                          {session.name}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] text-muted font-mono">
                            {formatTime(session.start_time)}
                          </span>
                          <span className="text-[10px] text-text-secondary flex items-center gap-0.5">
                            <Users className="w-2.5 h-2.5" />
                            {session.attendance_count}
                            {session.capacity && `/${session.capacity}`}
                          </span>
                        </div>
                      </button>
                    ))}
                    {items.length === 0 && dayTemplates.length > 0 && (
                      dayTemplates.map((t) => (
                        <div
                          key={t.id}
                          className="w-full mb-1.5 p-2 border border-dashed border-border rounded-[6px] opacity-50"
                        >
                          <p className="text-xs text-muted truncate">{t.name}</p>
                          <span className="text-[10px] text-muted font-mono">
                            {formatTime(t.start_time)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Day view */}
        {view === "day" && (
          <div className="flex-1 p-8">
            <h2 className="text-sm font-medium text-text-primary mb-4">
              {currentDate.toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </h2>
            {(() => {
              const ds = dateStr(currentDate);
              const daySessions = sessionsByDate[ds] || [];
              if (daySessions.length === 0) {
                return (
                  <div className="text-center py-12">
                    <Calendar className="w-6 h-6 text-muted mx-auto mb-2" />
                    <p className="text-sm text-text-secondary">
                      No sessions scheduled for this day.
                    </p>
                  </div>
                );
              }
              return (
                <div className="space-y-3">
                  {daySessions.map((session) => (
                    <button
                      key={session.id}
                      onClick={() => setSelectedSession(session)}
                      className="w-full text-left p-4 bg-surface border border-border rounded-[6px] hover:border-accent/50 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-text-primary">{session.name}</p>
                          <p className="text-xs text-muted font-mono mt-1">
                            {formatTime(session.start_time)} – {formatTime(session.end_time)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 text-text-secondary">
                          <Users className="w-3.5 h-3.5" />
                          <span className="text-sm font-mono">
                            {session.attendance_count}
                            {session.capacity && `/${session.capacity}`}
                          </span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Session detail / attendance modal */}
      {selectedSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setSelectedSession(null)}
          />
          <div className="relative bg-bg border border-border rounded-[6px] w-full max-w-lg max-h-[80vh] overflow-y-auto">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="text-base font-semibold text-text-primary">
                  {selectedSession.name}
                </h2>
                <p className="text-xs text-muted font-mono mt-0.5">
                  {formatTime(selectedSession.start_time)} –{" "}
                  {formatTime(selectedSession.end_time)}
                </p>
              </div>
              <button
                onClick={() => setSelectedSession(null)}
                className="p-1 text-muted hover:text-text-primary cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Roster */}
            <div className="p-5">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium text-text-secondary">
                  Roster — tap to check in
                </p>
                <p className="text-xs text-muted font-mono">
                  {getSessionAttendance(selectedSession.id).filter((a) => a.status !== "absent").length}
                  {selectedSession.capacity && `/${selectedSession.capacity}`} checked in
                </p>
              </div>

              <div className="space-y-1">
                {activeStudents.map((student) => {
                  const att = attendance.find(
                    (a) =>
                      a.session_id === selectedSession.id &&
                      a.student_id === student.id
                  );
                  const name = `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`;
                  return (
                    <button
                      key={student.id}
                      onClick={() =>
                        toggleCheckIn(selectedSession.id, student.id, name)
                      }
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-[6px] transition-colors cursor-pointer ${
                        att
                          ? att.status === "present"
                            ? "bg-success/10 border border-success/20"
                            : att.status === "late"
                            ? "bg-warning/10 border border-warning/20"
                            : att.status === "absent"
                            ? "bg-danger/10 border border-danger/20"
                            : "bg-surface-raised border border-border"
                          : "bg-surface border border-border hover:bg-surface-raised"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded-full bg-surface-raised border border-border flex items-center justify-center flex-shrink-0">
                          <span className="text-[10px] font-medium text-text-secondary">
                            {student.legal_first_name[0]}
                            {student.legal_last_name[0]}
                          </span>
                        </div>
                        <span className="text-sm text-text-primary">{name}</span>
                        {student.is_minor && (
                          <span className="text-[10px] text-muted">Minor</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {att && (
                          <>
                            {STATUS_ICON[att.status]}
                            <span
                              className={`text-xs capitalize ${
                                att.status === "present"
                                  ? "text-success"
                                  : att.status === "late"
                                  ? "text-warning"
                                  : att.status === "absent"
                                  ? "text-danger"
                                  : "text-muted"
                              }`}
                            >
                              {att.status}
                            </span>
                          </>
                        )}
                        {!att && (
                          <span className="text-xs text-muted">Tap to check in</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add class placeholder modal */}
      {showAddClass && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowAddClass(false)} />
          <div className="relative bg-bg border border-border rounded-[6px] w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-base font-semibold text-text-primary">Add recurring class</h2>
              <button onClick={() => setShowAddClass(false)} className="text-muted hover:text-text-primary cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-text-secondary font-medium">Class name</label>
                <input
                  type="text"
                  placeholder="e.g. Adult Gi Fundamentals"
                  className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">Day</label>
                  <select className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none">
                    {FULL_DAY_NAMES.map((d, i) => (
                      <option key={i} value={i}>{d}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">Capacity</label>
                  <input
                    type="number"
                    placeholder="30"
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">Start time</label>
                  <input
                    type="time"
                    defaultValue="18:00"
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">End time</label>
                  <input
                    type="time"
                    defaultValue="19:30"
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" size="sm" onClick={() => setShowAddClass(false)}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={() => setShowAddClass(false)}>
                  Create class
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
