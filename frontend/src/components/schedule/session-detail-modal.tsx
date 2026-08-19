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
import { ModalFrame } from "@/components/ui/modal-frame";
import {
  buildAttendanceByStudentId,
  areSessionAttendanceCountersReady,
  buildSessionAttendanceSummary,
  buildSessionLabels,
  buildSessionRosterSections,
  SESSION_STATUS_LABELS,
  type ScheduleSessionDeleteScope,
  type SessionRosterRow,
} from "@/lib/session-detail-model";
import type { AttendanceRecord, AttendanceStatus, ClassSession, Program, Student } from "@/types";

export type { ScheduleSessionDeleteScope } from "@/lib/session-detail-model";

export interface ScheduleSessionDetailModalProps {
  canManageSchedule: boolean;
  open: boolean;
  session: ClassSession | null;
  students: Student[];
  programs?: Program[];
  attendance: AttendanceRecord[];
  attendanceError?: string | null;
  onDismissAttendanceError?: () => void;
  studentRosterError?: string | null;
  onDismissStudentRosterError?: () => void;
  isLoadingStudentRoster?: boolean;
  isAttendanceReady?: boolean;
  isStudentRosterComplete?: boolean;
  pendingAttendanceStudentIds?: ReadonlySet<string>;
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

export function ScheduleSessionDetailModal({
  canManageSchedule,
  open,
  session,
  students,
  programs = [],
  attendance,
  attendanceError = null,
  onDismissAttendanceError,
  studentRosterError = null,
  onDismissStudentRosterError,
  isLoadingStudentRoster = false,
  isAttendanceReady = false,
  isStudentRosterComplete = false,
  pendingAttendanceStudentIds = new Set<string>(),
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

  const attendanceSummary = useMemo(
    () => buildSessionAttendanceSummary(attendance, students, open),
    [attendance, open, students]
  );

  const attendanceByStudentId = useMemo(
    () => buildAttendanceByStudentId(attendance, open),
    [attendance, open]
  );

  const rosterSections = useMemo(
    () => buildSessionRosterSections({ open, session, students, programs, attendanceByStudentId }),
    [attendanceByStudentId, open, programs, session, students]
  );

  const sessionLabels = useMemo(
    () => buildSessionLabels(open, session),
    [open, session]
  );

  if (!open || !session || !sessionLabels) {
    return null;
  }

  const activeSession = session;

  const showDeleteConfirm = deleteConfirmSessionId === activeSession.id;
  const { presentCount, absentCount, unmarkedCount } = attendanceSummary;
  const attendanceCountersReady = areSessionAttendanceCountersReady({
    attendanceReady: isAttendanceReady,
    rosterComplete: isStudentRosterComplete,
    rosterLoading: isLoadingStudentRoster,
  });
  const attendanceCommitCopy = !attendanceCountersReady
    ? "Attendance unavailable until the complete roster and class records load."
    : pendingAttendanceStudentIds.size > 0
      ? `Saving ${pendingAttendanceStudentIds.size} ${pendingAttendanceStudentIds.size === 1 ? "student" : "students"}…`
      : attendanceError
        ? "Last attendance change rolled back. Review the error, then try that row again."
        : "Saved as marked. Each row saves immediately.";
  const isRecurring = Boolean(activeSession.template_id);
  const canDeleteSeries = Boolean(isRecurring && onDeleteSeries);
  const isDeleting = deleteInFlight !== null;
  const hasClassProgram = Boolean(activeSession.program_id);
  const activeProgram = activeSession.program_id
    ? programs.find((program) => program.id === activeSession.program_id)
    : null;
  const programColor = activeProgram?.color_hex || "var(--accent)";

  function renderRosterRows(
    rows: SessionRosterRow[],
    options?: { markDropIns?: boolean }
  ) {
    return rows.map(({ student, attendanceRecord, studentName, initials, programs: studentPrograms }) => {
      const isCheckedIn = attendanceRecord && attendanceRecord.status !== "absent";
      return (
        <button
          key={student.id}
          data-attendance-student-id={student.id}
          disabled={!attendanceCountersReady || pendingAttendanceStudentIds.has(student.id)}
          onClick={async () => {
            await onToggleAttendance(activeSession.id, student.id, studentName);
          }}
          className={`group relative w-full text-left transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 overflow-hidden ${
            attendanceRecord
              ? "bg-surface-raised"
              : "bg-surface hover:bg-surface-raised/60"
          }`}
        >
          <div className="flex items-center justify-between gap-3 px-3 py-3">
            <div className="flex min-w-0 items-center gap-3">
              {/* Avatar */}
              <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] ${
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
                    <span className="shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
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
                    className={`text-xs font-medium ${
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
    <ModalFrame
      rootClassName="p-4"
      panelClassName="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-[18px] bg-bg"
      ariaLabelledBy="schedule-session-detail-title"
      onBackdropClick={() => {
        if (!isDeleting) {
          setDeleteConfirmSessionId(null);
          onClose();
        }
      }}
    >
        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4 border-b border-border p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h2
                id="schedule-session-detail-title"
                className="truncate text-lg font-semibold text-text-primary"
              >
                {activeSession.name}
              </h2>
              <span className="shrink-0 rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-text-secondary">
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
            className="shrink-0 rounded-[10px] p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Close session details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Stat bar ── */}
        <div
          className="grid shrink-0 grid-cols-3 gap-2 border-b border-border bg-surface p-2"
          aria-busy={!attendanceCountersReady}
          data-testid="attendance-summary"
        >
          <div className="rounded-[10px] bg-surface-raised px-4 py-3 text-center">
            <p className="text-2xl font-semibold tabular-nums text-text-primary leading-none">
              <span data-testid="attendance-present-count">
                {attendanceCountersReady ? presentCount : "—"}
              </span>
              {attendanceCountersReady && activeSession.capacity ? (
                <span className="text-sm font-normal text-muted">/{activeSession.capacity}</span>
              ) : null}
            </p>
            <p className="mt-1.5 text-xs text-muted">Present</p>
          </div>
          <div className="rounded-[10px] bg-surface-raised px-4 py-3 text-center">
            <p
              className="text-2xl font-semibold tabular-nums text-text-primary leading-none"
              data-testid="attendance-absent-count"
            >
              {attendanceCountersReady ? absentCount : "—"}
            </p>
            <p className="mt-1.5 text-xs text-muted">Absent</p>
          </div>
          <div className="rounded-[10px] bg-surface-raised px-4 py-3 text-center">
            <p
              className="text-2xl font-semibold tabular-nums text-text-primary leading-none"
              data-testid="attendance-unmarked-count"
            >
              {attendanceCountersReady ? unmarkedCount : "—"}
            </p>
            <p className="mt-1.5 text-xs text-muted">Unmarked</p>
          </div>
        </div>

        {/* ── Scrollable content ── */}
        <div className="flex-1 overflow-y-auto">

          {/* Notes */}
          {activeSession.notes ? (
            <div className="border-b border-border px-4 py-3">
              <p className="text-xs font-medium text-muted">Notes</p>
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

          {studentRosterError ? (
            <div className="px-6 pt-4">
              <DismissibleNotice
                tone="danger"
                onDismiss={() => onDismissStudentRosterError?.()}
              >
                {studentRosterError}
              </DismissibleNotice>
            </div>
          ) : null}

          {/* ── Roster ── */}
          <div className="p-4">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-text-primary">Attendance</p>
                <p
                  className="mt-1 text-xs text-text-secondary"
                  role="status"
                  aria-live="polite"
                  data-attendance-commit-state={
                    !attendanceCountersReady
                      ? "unavailable"
                      : pendingAttendanceStudentIds.size > 0
                        ? "saving"
                        : attendanceError
                          ? "rollback-error"
                          : "saved"
                  }
                >
                  {attendanceCommitCopy}
                </p>
                {attendanceCountersReady ? <p className="mt-1 text-[11px] text-muted">Select a student to cycle attendance status.</p> : null}
              </div>
              <span className="text-xs tabular-nums text-muted">
                {attendanceCountersReady
                  ? `${presentCount}${activeSession.capacity ? `/${activeSession.capacity}` : ""} in`
                  : "Attendance counts unavailable"}
              </span>
            </div>

            {students.length === 0 ? (
              <div className="rounded-[10px] bg-surface px-4 py-10 text-center">
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
                      <p className="text-xs font-medium text-muted">
                        {activeProgram?.name || "Program"} students
                      </p>
                      <span className="text-xs tabular-nums text-muted">{rosterSections.classProgramRows.length}</span>
                    </div>
                  )}

                  {rosterSections.classProgramRows.length > 0 ? (
                    <div className="divide-y divide-border/60 overflow-hidden rounded-[10px] bg-surface-raised/30">
                      {renderRosterRows(rosterSections.classProgramRows)}
                    </div>
                  ) : (
                    <div className="rounded-[10px] bg-surface-raised/40 px-4 py-4 text-xs text-muted">
                      No active students are assigned to this class program yet.
                    </div>
                  )}
                </div>

                {/* Drop-ins */}
                {hasClassProgram && (
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-xs font-medium text-muted">
                        Other program drop-ins
                      </p>
                      <span className="text-xs tabular-nums text-muted">{rosterSections.otherProgramRows.length}</span>
                    </div>
                    {rosterSections.otherProgramRows.length > 0 ? (
                      <div className="divide-y divide-border/60 overflow-hidden rounded-[10px] bg-surface-raised/30">
                        {renderRosterRows(rosterSections.otherProgramRows, { markDropIns: true })}
                      </div>
                    ) : (
                      <div className="rounded-[10px] bg-surface-raised/40 px-4 py-4 text-xs text-muted">
                        No other active students available for drop-in attendance.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Delete zone ── */}
          {canManageSchedule ? <div className="border-t border-border p-4">
            <div className="rounded-[14px] bg-danger/[0.03] p-4">
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
                  <p className="text-xs font-medium text-muted">
                    Confirm deletion
                  </p>

                  <div className="rounded-[10px] bg-bg/50 px-4 py-3">
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
                    <div className="rounded-[10px] bg-danger/10 px-4 py-3">
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
          </div> : null}
        </div>
    </ModalFrame>
  );
}
