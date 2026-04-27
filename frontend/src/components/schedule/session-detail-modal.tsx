"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  Check,
  Clock,
  Info,
  Repeat2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { ProgramBadge } from "@/components/programs/program-picker";
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
  present: <Check className="w-3 h-3 text-success" />,
  late: <Clock className="w-3 h-3 text-warning" />,
  excused: <AlertCircle className="w-3 h-3 text-muted" />,
  absent: <X className="w-3 h-3 text-danger" />,
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

  function renderRosterRows(
    rows: typeof rosterSections.classProgramRows,
    options?: { markDropIns?: boolean }
  ) {
    return rows.map(({ student, attendanceRecord, studentName, initials, programs: studentPrograms }) => (
      <button
        key={student.id}
        disabled={pendingAttendanceStudentId === student.id}
        onClick={async () => {
          await onToggleAttendance(activeSession.id, student.id, studentName);
        }}
        className={`w-full cursor-pointer rounded-[6px] px-3 py-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          attendanceRecord
            ? attendanceRecord.status === "present"
              ? "border border-success/20 bg-success/10"
              : attendanceRecord.status === "late"
                ? "border border-warning/20 bg-warning/10"
                : attendanceRecord.status === "absent"
                  ? "border border-danger/20 bg-danger/10"
                  : "border border-border bg-surface-raised"
            : "border border-border bg-surface hover:bg-surface-raised"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface-raised">
              <span className="text-[10px] font-medium text-text-secondary">
                {initials}
              </span>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="truncate text-left text-sm text-text-primary">{studentName}</p>
                {options?.markDropIns || attendanceRecord?.is_cross_program ? (
                  <span className="rounded-[4px] border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                    Drop-in
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {student.is_minor ? (
                  <span className="text-left text-[10px] text-muted">Minor</span>
                ) : null}
                {studentPrograms.length > 0 ? (
                  studentPrograms.slice(0, 2).map((program) => (
                    <ProgramBadge key={program.id} program={program} />
                  ))
                ) : hasClassProgram ? (
                  <ProgramBadge program={null} fallback="No matching program" />
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {attendanceRecord ? (
              <>
                {STATUS_ICON[attendanceRecord.status]}
                <span
                  className={`text-xs capitalize ${
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
              <span className="text-xs text-muted">Tap to check in</span>
            )}
          </div>
        </div>
      </button>
    ));
  }

  async function handleDelete(scope: ScheduleSessionDeleteScope) {
    if (scope === "series" && onDeleteSeries) {
      await onDeleteSeries(activeSession);
      return;
    }

    await onDeleteSession(activeSession);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60"
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
        className="relative flex w-full max-w-xl max-h-[85vh] flex-col overflow-hidden rounded-[6px] border border-border bg-bg"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="schedule-session-detail-title"
                className="text-base font-semibold text-text-primary"
              >
                {activeSession.name}
              </h2>
              {hasClassProgram ? <ProgramBadge program={activeProgram} fallback="Program" /> : null}
              <span className="rounded-full border border-border bg-surface-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-text-secondary">
                {SESSION_STATUS_LABELS[session.status]}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {sessionLabels.date} · {sessionLabels.startTime} - {sessionLabels.endTime}
            </p>
          </div>

          <button
            onClick={() => {
              if (!isDeleting) {
                setDeleteConfirmSessionId(null);
                onClose();
              }
            }}
            disabled={isDeleting}
            className="rounded-[6px] p-1 text-muted transition-colors hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Close session details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-[6px] border border-border bg-surface px-3 py-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                <Calendar className="h-3.5 w-3.5" />
                Date
              </div>
              <p className="mt-2 text-sm text-text-primary">{sessionLabels.date}</p>
            </div>

            <div className="rounded-[6px] border border-border bg-surface px-3 py-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                <Clock className="h-3.5 w-3.5" />
                Time
              </div>
              <p className="mt-2 text-sm text-text-primary">
                {sessionLabels.startTime} - {sessionLabels.endTime}
              </p>
            </div>

            <div className="rounded-[6px] border border-border bg-surface px-3 py-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                <Users className="h-3.5 w-3.5" />
                Attendance
              </div>
              <p className="mt-2 text-sm text-text-primary">
                {checkedInCount}
                {activeSession.capacity ? `/${activeSession.capacity}` : ""} checked in
              </p>
              {absentCount > 0 ? (
                <p className="mt-1 text-xs text-muted">{absentCount} marked absent</p>
              ) : null}
            </div>

            <div className="rounded-[6px] border border-border bg-surface px-3 py-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                {isRecurring ? <Repeat2 className="h-3.5 w-3.5" /> : <Info className="h-3.5 w-3.5" />}
                Series
              </div>
              <p className="mt-2 text-sm text-text-primary">
                {isRecurring ? "Recurring session" : "Standalone session"}
              </p>
              <p className="mt-1 text-xs text-muted">
                {isRecurring
                  ? "Be explicit about whether you remove one class or the full series."
                  : "Deleting this class only affects this scheduled session."}
              </p>
            </div>
          </div>

          {activeSession.notes ? (
            <div className="mt-4 rounded-[6px] border border-border bg-surface px-3 py-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Notes</p>
              <p className="mt-2 text-sm text-text-secondary">{activeSession.notes}</p>
            </div>
          ) : null}

          {attendanceError ? (
            <DismissibleNotice
              tone="danger"
              onDismiss={() => onDismissAttendanceError?.()}
              className="mt-4"
            >
              {attendanceError}
            </DismissibleNotice>
          ) : null}

          <div className="mt-5">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-text-secondary">Roster - tap to check in</p>
                <p className="mt-1 text-xs text-muted">
                  Fast attendance for between-class check-ins.
                </p>
              </div>
              <p className="text-xs text-muted font-mono">
                {checkedInCount}
                {activeSession.capacity ? `/${activeSession.capacity}` : ""} checked in
              </p>
            </div>

            {students.length === 0 ? (
              <div className="rounded-[6px] border border-border bg-surface px-4 py-8 text-center">
                <Users className="mx-auto mb-2 h-5 w-5 text-muted" />
                <p className="text-xs text-muted">
                  No active students. Add students first to take attendance.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1">
                  {hasClassProgram ? (
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-xs font-medium text-text-secondary">Class program students</p>
                      <ProgramBadge program={activeProgram} fallback="Program" />
                    </div>
                  ) : null}
                  {rosterSections.classProgramRows.length > 0 ? (
                    renderRosterRows(rosterSections.classProgramRows)
                  ) : (
                    <div className="rounded-[6px] border border-border bg-surface px-3 py-3 text-xs text-muted">
                      No active students are assigned to this class program yet.
                    </div>
                  )}
                </div>

                {hasClassProgram ? (
                  <div className="space-y-1 border-t border-border pt-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-xs font-medium text-text-secondary">Other program drop-ins</p>
                      <span className="text-xs text-muted">{rosterSections.otherProgramRows.length}</span>
                    </div>
                    {rosterSections.otherProgramRows.length > 0 ? (
                      renderRosterRows(rosterSections.otherProgramRows, { markDropIns: true })
                    ) : (
                      <div className="rounded-[6px] border border-border bg-surface px-3 py-3 text-xs text-muted">
                        No other active students available for drop-in attendance.
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <div className="rounded-[6px] border border-danger/20 bg-danger/5 px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0 text-danger" />
                    <p className="text-sm font-medium text-text-primary">Delete class</p>
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
                <div className="mt-4 space-y-3 border-t border-danger/20 pt-4">
                  <p className="text-xs font-medium text-text-secondary">
                    Confirm deletion
                  </p>

                  <div className="rounded-[6px] border border-border bg-bg/50 px-3 py-3">
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
                    <div className="rounded-[6px] border border-danger/20 bg-danger/10 px-3 py-3">
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
