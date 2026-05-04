"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  Check,
  Clock,
  Repeat2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import type { AttendanceRecord, AttendanceStatus, ClassSession, Program, Student } from "@/types";

export type ScheduleSessionDeleteScope = "session" | "series";

export interface ScheduleSessionDetailModalProps {
  open: boolean;
  session: ClassSession | null;
  students: Student[];
  programs?: Program[];
  attendance: AttendanceRecord[];
  attendanceError?: string | null;
  onDismissAttendanceError?: () => void;
  pendingAttendanceStudentId?: string | null;
  deleteError?: string | null;
  deleteInFlight?: ScheduleSessionDeleteScope | null;
  onClose: () => void;
  onToggleAttendance: (
    sessionId: string,
    studentId: string,
    studentName: string
  ) => Promise<void> | void;
  onDeleteSession: (session: ClassSession) => Promise<void> | void;
  onDeleteSeries?: (session: ClassSession) => Promise<void> | void;
}

const STATUS_ICON: Record<AttendanceStatus, ReactNode> = {
  present: <Check className="w-3.5 h-3.5 text-success" />,
  late: <Clock className="w-3.5 h-3.5 text-warning" />,
  excused: <AlertCircle className="w-3.5 h-3.5 text-muted" />,
  absent: <X className="w-3.5 h-3.5 text-danger" />,
};

const STATUS_ACCENT: Record<AttendanceStatus, string> = {
  present: "bg-success",
  late: "bg-warning",
  excused: "bg-muted",
  absent: "bg-danger",
};

const SESSION_STATUS_LABELS: Record<ClassSession["status"], string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  canceled: "Canceled",
};

function formatTime(value: string) {
  const [hours, minutes] = value.split(":");
  const hour = parseInt(hours, 10);
  const ampm = hour >= 12 ? "PM" : "AM";
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${hour12}:${minutes} ${ampm}`;
}

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function getStudentName(student: Student) {
  return `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`;
}

function getActiveStudentProgramIds(student: Student) {
  const membershipProgramIds = (student.program_memberships || [])
    .filter((membership) => membership.status !== "ended" && !membership.ended_at)
    .map((membership) => membership.program_id);

  return Array.from(new Set([...membershipProgramIds, student.program_id].filter(Boolean) as string[]));
}

function studentBelongsToProgram(student: Student, programId: string) {
  return getActiveStudentProgramIds(student).includes(programId);
}

export function ScheduleSessionDetailModal({
  open,
  session,
  students,
  programs = [],
  attendance,
  attendanceError = null,
  onDismissAttendanceError,
  pendingAttendanceStudentId = null,
  deleteError = null,
  deleteInFlight = null,
  onClose,
  onToggleAttendance,
  onDeleteSession,
  onDeleteSeries,
}: ScheduleSessionDetailModalProps) {
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !deleteInFlight) {
        setDeleteConfirmSessionId(null);
        onClose();
      }
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [deleteInFlight, onClose, open]);

  const attendanceSummary = useMemo(() => {
    if (!open) {
      return { checkedInCount: 0, absentCount: 0 };
    }

    let checkedInCount = 0;
    let absentCount = 0;

    for (const record of attendance) {
      if (record.status === "absent") {
        absentCount += 1;
      } else {
        checkedInCount += 1;
      }
    }

    return { checkedInCount, absentCount };
  }, [attendance, open]);

  const attendanceByStudentId = useMemo(() => {
    if (!open) {
      return new Map<string, AttendanceRecord>();
    }

    return new Map(attendance.map((record) => [record.student_id, record]));
  }, [attendance, open]);

  const rosterSections = useMemo(
    () => {
      if (!open || !session) {
        return { classProgramRows: [], otherProgramRows: [] };
      }

      const rows = students
        .map((student) => {
          const studentProgramIds = getActiveStudentProgramIds(student);
          return {
            student,
            attendanceRecord: attendanceByStudentId.get(student.id),
            studentName: getStudentName(student),
            initials: `${student.legal_first_name[0] ?? ""}${student.legal_last_name[0] ?? ""}`,
            programs: studentProgramIds
              .map((programId) => programs.find((program) => program.id === programId))
              .filter(Boolean) as Program[],
          };
        })
        .sort((left, right) => left.studentName.localeCompare(right.studentName));

      if (!session.program_id) {
        return { classProgramRows: rows, otherProgramRows: [] };
      }

      return {
        classProgramRows: rows.filter(({ student }) => studentBelongsToProgram(student, session.program_id!)),
        otherProgramRows: rows.filter(({ student }) => !studentBelongsToProgram(student, session.program_id!)),
      };
    },
    [attendanceByStudentId, open, programs, session, students]
  );

  const sessionLabels = useMemo(() => {
    if (!open || !session) {
      return null;
    }

    return {
      date: formatDate(session.date),
      startTime: formatTime(session.start_time),
      endTime: formatTime(session.end_time),
    };
  }, [open, session]);

  if (!open || !session || !sessionLabels) {
    return null;
  }

  const activeSession = session;

  const showDeleteConfirm = deleteConfirmSessionId === activeSession.id;
  const { checkedInCount, absentCount } = attendanceSummary;
  const isRecurring = Boolean(activeSession.template_id);
  const canDeleteSeries = Boolean(isRecurring && onDeleteSeries);
  const isDeleting = deleteInFlight !== null;
  const hasClassProgram = Boolean(activeSession.program_id);
  const activeProgram = activeSession.program_id
    ? programs.find((program) => program.id === activeSession.program_id)
    : null;
  const programColor = activeProgram?.color_hex || "var(--accent)";

  function renderRosterRows(
    rows: typeof rosterSections.classProgramRows,
    options?: { markDropIns?: boolean }
  ) {
    return rows.map(({ student, attendanceRecord, studentName, initials, programs: studentPrograms }) => {
      const isCheckedIn = attendanceRecord && attendanceRecord.status !== "absent";
      const statusColor = attendanceRecord ? STATUS_ACCENT[attendanceRecord.status] : "";

      return (
        <button
          key={student.id}
          disabled={pendingAttendanceStudentId === student.id}
          onClick={async () => {
            await onToggleAttendance(activeSession.id, student.id, studentName);
          }}
          className={`group relative w-full text-left transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 overflow-hidden ${
            attendanceRecord
              ? "bg-surface-raised"
              : "bg-surface hover:bg-surface-raised/60"
          }`}
        >
          {/* Left status accent bar */}
          <span
            className={`absolute left-0 top-0 bottom-0 w-[3px] ${
              attendanceRecord ? statusColor : "bg-transparent group-hover:bg-border"
            }`}
          />

          <div className="flex items-center justify-between gap-3 py-3 pl-4 pr-3">
            <div className="flex min-w-0 items-center gap-3">
              {/* Avatar */}
              <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center border ${
                isCheckedIn
                  ? "border-success/30 bg-success/10"
                  : attendanceRecord?.status === "absent"
                    ? "border-danger/30 bg-danger/10"
                    : "border-border bg-surface-raised"
              }`}>
                {isCheckedIn ? (
                  <Check className="w-3.5 h-3.5 text-success" />
                ) : attendanceRecord?.status === "absent" ? (
                  <X className="w-3.5 h-3.5 text-danger" />
                ) : (
                  <span className="text-[10px] font-semibold text-text-secondary">
                    {initials}
                  </span>
                )}
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-text-primary">{studentName}</p>
                  {(options?.markDropIns || attendanceRecord?.is_cross_program) && (
                    <span className="border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning shrink-0">
                      Drop-in
                    </span>
                  )}
                  {student.is_minor && (
                    <span className="text-[10px] text-muted shrink-0">Minor</span>
                  )}
                </div>
                {studentPrograms.length > 0 && (
                  <p className="mt-0.5 text-[10px] text-muted truncate">
                    {studentPrograms.slice(0, 2).map((p) => p.name).join(" · ")}
                  </p>
                )}
              </div>
            </div>

            {/* Status indicator */}
            <div className="flex items-center gap-2 shrink-0">
              {attendanceRecord ? (
                <>
                  {STATUS_ICON[attendanceRecord.status]}
                  <span
                    className={`text-[11px] font-medium uppercase tracking-wide ${
                      attendanceRecord.status === "present"
                        ? "text-success"
                        : attendanceRecord.status === "late"
                          ? "text-warning"
                          : attendanceRecord.status === "absent"
                            ? "text-danger"
                            : "text-muted"
                    }`}
                  >
                    {attendanceRecord.status}
                  </span>
                </>
              ) : (
                <span className="text-[11px] text-muted group-hover:text-text-secondary transition-colors">
                  Check in
                </span>
              )}
            </div>
          </div>
        </button>
      );
    });
  }

  async function handleDelete(scope: ScheduleSessionDeleteScope) {
    if (scope === "series" && onDeleteSeries) {
      await onDeleteSeries(activeSession);
      return;
    }

    await onDeleteSession(activeSession);
  }

  return (
    <div className="koaryu-modal-root p-4">
      <div
        className="koaryu-modal-backdrop"
        onClick={() => {
          if (!isDeleting) {
            setDeleteConfirmSessionId(null);
            onClose();
          }
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-session-detail-title"
        className="koaryu-modal-panel flex w-full max-w-xl max-h-[85vh] flex-col overflow-hidden border border-border bg-bg"
      >
        {/* ── Program color top accent ── */}
        <span
          className="block h-[3px] w-full shrink-0"
          style={{ backgroundColor: programColor }}
        />

        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h2
                id="schedule-session-detail-title"
                className="text-lg font-bold text-text-primary truncate"
              >
                {activeSession.name}
              </h2>
              <span className="border border-border bg-surface-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-text-secondary shrink-0">
                {SESSION_STATUS_LABELS[session.status]}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="w-3 h-3 text-muted" />
                {sessionLabels.date}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-muted" />
                {sessionLabels.startTime} – {sessionLabels.endTime}
              </span>
              {hasClassProgram && (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 shrink-0"
                    style={{ backgroundColor: programColor }}
                  />
                  {activeProgram?.name || "Program"}
                </span>
              )}
              {isRecurring && (
                <span className="inline-flex items-center gap-1.5">
                  <Repeat2 className="w-3 h-3 text-muted" />
                  Recurring
                </span>
              )}
            </div>
          </div>

          <button
            onClick={() => {
              if (!isDeleting) {
                setDeleteConfirmSessionId(null);
                onClose();
              }
            }}
            disabled={isDeleting}
            className="p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 shrink-0"
            aria-label="Close session details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Stat bar ── */}
        <div className="grid grid-cols-3 border-b border-border bg-surface divide-x divide-border shrink-0">
          <div className="px-4 py-3.5 text-center">
            <p className="text-2xl font-bold font-mono text-text-primary leading-none">
              {checkedInCount}
              {activeSession.capacity ? (
                <span className="text-sm font-normal text-muted">/{activeSession.capacity}</span>
              ) : null}
            </p>
            <p className="text-[10px] text-muted uppercase tracking-widest mt-1.5">checked in</p>
          </div>
          <div className="px-4 py-3.5 text-center">
            <p className="text-2xl font-bold font-mono text-text-primary leading-none">{absentCount}</p>
            <p className="text-[10px] text-muted uppercase tracking-widest mt-1.5">absent</p>
          </div>
          <div className="px-4 py-3.5 text-center">
            <p className="text-2xl font-bold font-mono text-text-primary leading-none">{students.length}</p>
            <p className="text-[10px] text-muted uppercase tracking-widest mt-1.5">roster</p>
          </div>
        </div>

        {/* ── Scrollable content ── */}
        <div className="flex-1 overflow-y-auto">

          {/* Notes */}
          {activeSession.notes ? (
            <div className="border-b border-border px-6 py-3">
              <p className="text-[10px] font-medium uppercase tracking-widest text-muted">Notes</p>
              <p className="mt-1 text-sm text-text-secondary">{activeSession.notes}</p>
            </div>
          ) : null}

          {attendanceError ? (
            <div className="px-6 pt-4">
              <DismissibleNotice
                tone="danger"
                onDismiss={() => onDismissAttendanceError?.()}
              >
                {attendanceError}
              </DismissibleNotice>
            </div>
          ) : null}

          {/* ── Roster ── */}
          <div className="px-6 py-5">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-text-primary">Attendance</p>
                <p className="mt-0.5 text-xs text-muted">Tap any student to toggle check-in</p>
              </div>
              <span className="text-xs text-muted font-mono">
                {checkedInCount}{activeSession.capacity ? `/${activeSession.capacity}` : ""} in
              </span>
            </div>

            {students.length === 0 ? (
              <div className="border border-border bg-surface px-4 py-10 text-center">
                <Users className="mx-auto mb-2 h-5 w-5 text-muted" />
                <p className="text-xs text-muted">
                  No active students. Add students first to take attendance.
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                {/* Class program students */}
                <div>
                  {hasClassProgram && (
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-[11px] font-medium uppercase tracking-widest text-muted">
                        {activeProgram?.name || "Program"} students
                      </p>
                      <span className="text-[11px] text-muted font-mono">{rosterSections.classProgramRows.length}</span>
                    </div>
                  )}

                  {rosterSections.classProgramRows.length > 0 ? (
                    <div className="border border-border divide-y divide-border/60">
                      {renderRosterRows(rosterSections.classProgramRows)}
                    </div>
                  ) : (
                    <div className="border border-border bg-surface-raised/40 px-4 py-4 text-xs text-muted">
                      No active students are assigned to this class program yet.
                    </div>
                  )}
                </div>

                {/* Drop-ins */}
                {hasClassProgram && (
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-[11px] font-medium uppercase tracking-widest text-muted">
                        Other program drop-ins
                      </p>
                      <span className="text-[11px] text-muted font-mono">{rosterSections.otherProgramRows.length}</span>
                    </div>
                    {rosterSections.otherProgramRows.length > 0 ? (
                      <div className="border border-border divide-y divide-border/60">
                        {renderRosterRows(rosterSections.otherProgramRows, { markDropIns: true })}
                      </div>
                    ) : (
                      <div className="border border-border bg-surface-raised/40 px-4 py-4 text-xs text-muted">
                        No other active students available for drop-in attendance.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Delete zone ── */}
          <div className="border-t border-border px-6 py-5">
            <div className="border border-danger/15 bg-danger/[0.03] px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-danger" />
                    <p className="text-sm font-semibold text-text-primary">Delete class</p>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {isRecurring
                      ? canDeleteSeries
                        ? "This session belongs to a recurring series. Choose whether to delete this class or stop this series."
                        : "This session belongs to a recurring series. This modal can remove just this scheduled class."
                      : "This permanently removes the scheduled class from the calendar."}
                  </p>
                </div>

                {!showDeleteConfirm ? (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={isDeleting}
                    onClick={() => setDeleteConfirmSessionId(session.id)}
                    className="shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isDeleting}
                    onClick={() => setDeleteConfirmSessionId(null)}
                    className="shrink-0"
                  >
                    Keep class
                  </Button>
                )}
              </div>

              {deleteError ? (
                <p className="mt-3 text-xs text-danger">{deleteError}</p>
              ) : null}

              {showDeleteConfirm ? (
                <div className="mt-4 space-y-3 border-t border-danger/15 pt-4">
                  <p className="text-[11px] font-medium uppercase tracking-widest text-muted">
                    Confirm deletion
                  </p>

                  <div className="border border-border bg-bg/50 px-4 py-3">
                    <p className="text-sm font-medium text-text-primary">Delete this class</p>
                    <p className="mt-1 text-xs text-muted">
                      Removes the selected occurrence and keeps the rest of the schedule intact.
                    </p>
                    <div className="mt-3 flex justify-end">
                      <Button
                        variant="danger"
                        size="sm"
                        isLoading={deleteInFlight === "session"}
                        disabled={isDeleting}
                        onClick={() => void handleDelete("session")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete this class
                      </Button>
                    </div>
                  </div>

                  {canDeleteSeries ? (
                    <div className="border border-danger/20 bg-danger/10 px-4 py-3">
                      <p className="text-sm font-medium text-text-primary">Stop this series</p>
                      <p className="mt-1 text-xs text-muted">
                        Removes this class and future recurring sessions that belong to the same series.
                      </p>
                      <div className="mt-3 flex justify-end">
                        <Button
                          variant="danger"
                          size="sm"
                          isLoading={deleteInFlight === "series"}
                          disabled={isDeleting}
                          onClick={() => void handleDelete("series")}
                          className="!border-transparent !bg-danger !text-white hover:!bg-danger/80"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Stop this series
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
