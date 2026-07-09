import type { AttendanceRecord, ClassSession, Program, Student } from "@/types";

export type ScheduleSessionDeleteScope = "session" | "series";

export const SESSION_STATUS_LABELS: Record<ClassSession["status"], string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  canceled: "Canceled",
};

export interface SessionAttendanceSummary {
  checkedInCount: number;
  absentCount: number;
}

export interface SessionRosterRow {
  student: Student;
  attendanceRecord?: AttendanceRecord;
  studentName: string;
  initials: string;
  programs: Program[];
}

export interface SessionRosterSections {
  classProgramRows: SessionRosterRow[];
  otherProgramRows: SessionRosterRow[];
}

export interface SessionLabels {
  date: string;
  startTime: string;
  endTime: string;
}

interface BuildSessionRosterSectionsOptions {
  open: boolean;
  session: ClassSession | null;
  students: Student[];
  programs: Program[];
  attendanceByStudentId: Map<string, AttendanceRecord>;
}

export function formatSessionTime(value: string) {
  const [hours, minutes] = value.split(":");
  const hour = parseInt(hours, 10);
  const ampm = hour >= 12 ? "PM" : "AM";
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${hour12}:${minutes} ${ampm}`;
}

export function formatSessionDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function getScheduleStudentName(student: Student) {
  return `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`;
}

export function getActiveStudentProgramIds(student: Student) {
  const membershipProgramIds = (student.program_memberships || [])
    .filter((membership) => membership.status !== "ended" && !membership.ended_at)
    .map((membership) => membership.program_id);

  return Array.from(new Set([...membershipProgramIds, student.program_id].filter(Boolean) as string[]));
}

export function studentBelongsToProgram(student: Student, programId: string) {
  return getActiveStudentProgramIds(student).includes(programId);
}

export function buildSessionAttendanceSummary(
  attendance: AttendanceRecord[],
  open: boolean
): SessionAttendanceSummary {
  if (!open) {
    return { checkedInCount: 0, absentCount: 0 };
  }

  let checkedInCount = 0;
  let absentCount = 0;

  for (const record of buildAttendanceByStudentId(attendance, open).values()) {
    if (record.status === "absent") {
      absentCount += 1;
    } else {
      checkedInCount += 1;
    }
  }

  return { checkedInCount, absentCount };
}

export function buildAttendanceByStudentId(attendance: AttendanceRecord[], open: boolean) {
  if (!open) {
    return new Map<string, AttendanceRecord>();
  }

  return new Map(attendance.map((record) => [record.student_id, record]));
}

export function buildSessionRosterSections({
  open,
  session,
  students,
  programs,
  attendanceByStudentId,
}: BuildSessionRosterSectionsOptions): SessionRosterSections {
  if (!open || !session) {
    return { classProgramRows: [], otherProgramRows: [] };
  }

  const rows = students
    .map((student) => {
      const studentProgramIds = getActiveStudentProgramIds(student);
      const initials = `${student.legal_first_name[0] ?? ""}${student.legal_last_name[0] ?? ""}`;

      return {
        student,
        attendanceRecord: attendanceByStudentId.get(student.id),
        studentName: getScheduleStudentName(student),
        initials,
        programs: studentProgramIds
          .map((programId) => programs.find((program) => program.id === programId))
          .filter(Boolean) as Program[],
        studentProgramIds,
      };
    })
    .sort((left, right) => left.studentName.localeCompare(right.studentName));

  if (!session.program_id) {
    return { classProgramRows: rows, otherProgramRows: [] };
  }

  return {
    classProgramRows: rows.filter((row) => row.studentProgramIds.includes(session.program_id!)),
    otherProgramRows: rows.filter((row) => !row.studentProgramIds.includes(session.program_id!)),
  };
}

export function buildSessionLabels(open: boolean, session: ClassSession | null): SessionLabels | null {
  if (!open || !session) {
    return null;
  }

  return {
    date: formatSessionDate(session.date),
    startTime: formatSessionTime(session.start_time),
    endTime: formatSessionTime(session.end_time),
  };
}
