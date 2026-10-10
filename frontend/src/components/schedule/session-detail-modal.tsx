"use client";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { AlertCircle, Check, Clock, Repeat2, Search, Trash2, Users, X } from "lucide-react";
import { getProgramColor } from "@/components/schedule/schedule-display";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { CalmState, ToneTag, type HorizonTone } from "@/components/schedule/horizon-parts";
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
import styles from "./session-detail-modal.module.css";

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
    studentName: string,
  ) => Promise<void> | void;
  onDeleteSession: (session: ClassSession) => Promise<void> | void;
  onDeleteSeries?: (session: ClassSession) => Promise<void> | void;
}

const STATUS_ICON: Record<AttendanceStatus, ReactNode> = {
  present: <Check aria-hidden="true" />,
  late: <Clock aria-hidden="true" />,
  excused: <AlertCircle aria-hidden="true" />,
  absent: <X aria-hidden="true" />,
};

const SESSION_STATUS_TONE: Record<ClassSession["status"], HorizonTone> = {
  scheduled: "neutral",
  in_progress: "warn",
  completed: "calm",
  canceled: "alert",
};

/** Search appears once a roster is long enough that scanning by eye is slower than typing. */
const ROSTER_SEARCH_THRESHOLD = 10;

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
  const [rosterQuery, setRosterQuery] = useState("");

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
    [attendance, open, students],
  );

  const attendanceByStudentId = useMemo(
    () => buildAttendanceByStudentId(attendance, open),
    [attendance, open],
  );

  const rosterSections = useMemo(
    () => buildSessionRosterSections({ open, session, students, programs, attendanceByStudentId }),
    [attendanceByStudentId, open, programs, session, students],
  );

  const sessionLabels = useMemo(() => buildSessionLabels(open, session), [open, session]);

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
  const programColor = getProgramColor(activeProgram);
  const capacity = activeSession.capacity ?? null;
  const fillRatio =
    attendanceCountersReady && capacity ? Math.min(1, presentCount / capacity) : null;
  const emptyRosterMessage = isLoadingStudentRoster
    ? "Loading the student roster."
    : studentRosterError
      ? "The student roster is unavailable."
      : !isStudentRosterComplete
        ? "The student roster is incomplete. Attendance will be available after all students load."
        : "No active students. Add students first to take attendance.";
  const showRosterSearch = students.length >= ROSTER_SEARCH_THRESHOLD;
  const normalizedQuery = showRosterSearch ? rosterQuery.trim().toLocaleLowerCase() : "";
  const matchesQuery = (row: SessionRosterRow) =>
    !normalizedQuery || row.studentName.toLocaleLowerCase().includes(normalizedQuery);
  const classProgramRows = rosterSections.classProgramRows.filter(matchesQuery);
  const otherProgramRows = rosterSections.otherProgramRows.filter(matchesQuery);

  function close() {
    if (!isDeleting) {
      setDeleteConfirmSessionId(null);
      onClose();
    }
  }

  function renderRosterRows(rows: SessionRosterRow[], options?: { markDropIns?: boolean }) {
    return rows.map(
      ({ student, attendanceRecord, studentName, initials, programs: studentPrograms }) => {
        const status = attendanceRecord?.status ?? null;
        return (
          <li key={student.id}>
            <button
              type="button"
              data-attendance-student-id={student.id}
              data-status={status ?? "unmarked"}
              disabled={!attendanceCountersReady || pendingAttendanceStudentIds.has(student.id)}
              onClick={async () => {
                await onToggleAttendance(activeSession.id, student.id, studentName);
              }}
              className={styles.rosterRow}
            >
              <span className={styles.avatar} aria-hidden="true">
                {status ? STATUS_ICON[status] : initials}
              </span>

              <span className={styles.rosterText}>
                <span className={styles.rosterNameLine}>
                  <strong>{studentName}</strong>
                  {(options?.markDropIns || attendanceRecord?.is_cross_program) && (
                    <ToneTag tone="warn" dot={false}>
                      Drop-in
                    </ToneTag>
                  )}
                  {student.is_minor && <span className={styles.minor}>Minor</span>}
                </span>
                {studentPrograms.length > 0 && (
                  <small>
                    {studentPrograms
                      .slice(0, 2)
                      .map((p) => p.name)
                      .join(" · ")}
                  </small>
                )}
              </span>

              <span className={styles.rosterStatus} data-status={status ?? "unmarked"}>
                {status ? status : "Check in"}
              </span>
            </button>
          </li>
        );
      },
    );
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
      panelClassName={styles.sheet}
      ariaLabelledBy="schedule-session-detail-title"
      onBackdropClick={close}
    >
      <div
        className={styles.sheetInner}
        style={{ "--program-color": programColor } as CSSProperties}
      >
        {/* Header */}
        <header className={styles.head}>
          <div className={styles.headCopy}>
            <p className={styles.eyebrow}>
              {sessionLabels.date} · {sessionLabels.startTime} – {sessionLabels.endTime}
            </p>
            <div className={styles.titleRow}>
              <h2 id="schedule-session-detail-title" className={styles.title}>
                {activeSession.name}
              </h2>
              <ToneTag tone={SESSION_STATUS_TONE[session.status]}>
                {SESSION_STATUS_LABELS[session.status]}
              </ToneTag>
            </div>
            <div className={styles.meta}>
              {hasClassProgram && (
                <span className={styles.programName}>
                  <i aria-hidden="true" />
                  {activeProgram?.name || "Program"}
                </span>
              )}
              {isRecurring && (
                <span>
                  <Repeat2 aria-hidden="true" />
                  Recurring
                </span>
              )}
              {capacity ? (
                <span>
                  <Users aria-hidden="true" />
                  {capacity} seats
                </span>
              ) : null}
            </div>
          </div>

          <button
            type="button"
            onClick={close}
            disabled={isDeleting}
            className={styles.close}
            aria-label="Close session details"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        {/* Attendance figures */}
        <div
          className={styles.summary}
          aria-busy={!attendanceCountersReady}
          data-testid="attendance-summary"
        >
          <div className={styles.present}>
            <p className={styles.figureLabel}>Present</p>
            <p className={styles.presentValue}>
              <span data-testid="attendance-present-count">
                {attendanceCountersReady ? presentCount : "—"}
              </span>
              {attendanceCountersReady && capacity ? <small>/{capacity}</small> : null}
            </p>
            <span className={styles.meter} aria-hidden="true">
              <span style={{ width: `${(fillRatio ?? 0) * 100}%` }} />
            </span>
          </div>
          <div
            className={styles.figure}
            data-tone={attendanceCountersReady && absentCount > 0 ? "absent" : undefined}
          >
            <p className={styles.figureLabel}>Absent</p>
            <p className={styles.figureValue} data-testid="attendance-absent-count">
              {attendanceCountersReady ? absentCount : "—"}
            </p>
          </div>
          <div className={styles.figure}>
            <p className={styles.figureLabel}>Unmarked</p>
            <p className={styles.figureValue} data-testid="attendance-unmarked-count">
              {attendanceCountersReady ? unmarkedCount : "—"}
            </p>
          </div>
        </div>

        <div className={styles.body}>
          {activeSession.notes ? (
            <div className={styles.notes}>
              <p>Notes</p>
              <p>{activeSession.notes}</p>
            </div>
          ) : null}

          {attendanceError ? (
            <DismissibleNotice tone="danger" onDismiss={() => onDismissAttendanceError?.()}>
              {attendanceError}
            </DismissibleNotice>
          ) : null}

          {studentRosterError ? (
            <DismissibleNotice tone="danger" onDismiss={() => onDismissStudentRosterError?.()}>
              {studentRosterError}
            </DismissibleNotice>
          ) : null}

          {/* Roster */}
          <section className={styles.roster} aria-labelledby="schedule-session-roster-title">
            <div className={styles.rosterHead}>
              <div>
                <h3 id="schedule-session-roster-title" className={styles.rosterTitle}>
                  Attendance
                </h3>
                <p
                  className={styles.commit}
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
                {attendanceCountersReady ? (
                  <p className={styles.hint}>
                    Tap a student to check them in. Tap again for late, absent, then clear.
                  </p>
                ) : null}
              </div>
              {showRosterSearch ? (
                <label className={styles.search}>
                  <Search aria-hidden="true" />
                  <span className="sr-only">Find a student</span>
                  <input
                    type="search"
                    value={rosterQuery}
                    placeholder="Find a student"
                    onChange={(event) => setRosterQuery(event.target.value)}
                  />
                </label>
              ) : null}
            </div>

            {students.length === 0 ? (
              <CalmState tone="neutral" icon={<Users />} title={emptyRosterMessage} />
            ) : (
              <div className={styles.rosterGroups}>
                <div>
                  {hasClassProgram && (
                    <p className={styles.groupLabel}>
                      <span>{activeProgram?.name || "Program"} students</span>
                      <b>{rosterSections.classProgramRows.length}</b>
                    </p>
                  )}

                  {classProgramRows.length > 0 ? (
                    <ul className={styles.rosterList}>{renderRosterRows(classProgramRows)}</ul>
                  ) : (
                    <p className={styles.groupEmpty}>
                      {normalizedQuery
                        ? "No students in this program match that name."
                        : "No active students are assigned to this class program yet."}
                    </p>
                  )}
                </div>

                {hasClassProgram && (
                  <div>
                    <p className={styles.groupLabel}>
                      <span>Other program drop-ins</span>
                      <b>{rosterSections.otherProgramRows.length}</b>
                    </p>
                    {otherProgramRows.length > 0 ? (
                      <ul className={styles.rosterList}>
                        {renderRosterRows(otherProgramRows, { markDropIns: true })}
                      </ul>
                    ) : (
                      <p className={styles.groupEmpty}>
                        {normalizedQuery
                          ? "No drop-in students match that name."
                          : "No other active students available for drop-in attendance."}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Delete */}
          {canManageSchedule ? (
            <section className={styles.danger} aria-label="Delete class">
              <div className={styles.dangerHead}>
                <div>
                  <p className={styles.dangerTitle}>Delete class</p>
                  <p className={styles.dangerCopy}>
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
                    variant="secondary"
                    size="sm"
                    disabled={isDeleting}
                    onClick={() => setDeleteConfirmSessionId(null)}
                    className="shrink-0"
                  >
                    Keep class
                  </Button>
                )}
              </div>

              {deleteError ? <p className={styles.dangerError}>{deleteError}</p> : null}

              {showDeleteConfirm ? (
                <div className={styles.confirm}>
                  <p className={styles.confirmLabel}>Confirm deletion</p>

                  <div className={styles.confirmOption}>
                    <div>
                      <p className={styles.confirmTitle}>Delete this class</p>
                      <p className={styles.dangerCopy}>
                        Removes the selected occurrence and keeps the rest of the schedule intact.
                      </p>
                    </div>
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

                  {canDeleteSeries ? (
                    <div className={styles.confirmOption} data-severity="series">
                      <div>
                        <p className={styles.confirmTitle}>Stop this series</p>
                        <p className={styles.dangerCopy}>
                          Removes this class and future recurring sessions that belong to the same
                          series.
                        </p>
                      </div>
                      <Button
                        variant="danger"
                        size="sm"
                        isLoading={deleteInFlight === "series"}
                        disabled={isDeleting}
                        onClick={() => void handleDelete("series")}
                        className={styles.seriesButton}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Stop this series
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </ModalFrame>
  );
}
