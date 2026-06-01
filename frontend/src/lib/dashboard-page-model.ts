import type { AttendanceRecord, BeltRank, ClassSession, EligibilityEntry, Lead, Program, Student } from "@/types";
import type { DashboardSummaryRecentStudent } from "@/types/dashboard";

function dashboardStudentStartDate(student: { membership_start_date?: string | null; created_at: string }) {
  return student.membership_start_date || student.created_at.slice(0, 10);
}

function isDashboardStudentOnHoldNow(
  student: Pick<Student, "status" | "hold_start_date" | "hold_end_date">,
  today: string
) {
  if (student.status === "paused") {
    return true;
  }

  if (!student.hold_start_date) {
    return false;
  }

  if (student.hold_start_date > today) {
    return false;
  }

  if (!student.hold_end_date) {
    return true;
  }

  return student.hold_end_date >= today;
}

export function buildDashboardStudentStats(students: Student[], today: string) {
  let activeStudents = 0;
  let trialingStudents = 0;
  let onHoldStudents = 0;

  for (const student of students) {
    if (student.status === "active" || student.status === "trialing") {
      activeStudents += 1;
    }

    if (student.status === "trialing") {
      trialingStudents += 1;
    }

    if (isDashboardStudentOnHoldNow(student, today)) {
      onHoldStudents += 1;
    }
  }

  return {
    totalStudents: students.length,
    activeStudents,
    trialingStudents,
    onHoldStudents,
  };
}

export function buildDashboardLeadStats(leads: Lead[], today: string) {
  let activeLeads = 0;
  let enrolledLeads = 0;
  let dueTodayLeads = 0;

  for (const lead of leads) {
    if (lead.stage === "enrolled") {
      enrolledLeads += 1;
      continue;
    }

    if (lead.stage === "closed_lost") {
      continue;
    }

    activeLeads += 1;

    if (lead.follow_up_date && lead.follow_up_date <= today) {
      dueTodayLeads += 1;
    }
  }

  return { activeLeads, enrolledLeads, dueTodayLeads };
}

export function countDashboardTodaySessions(sessions: ClassSession[], today: string) {
  return sessions.reduce((count, session) => count + (session.date === today ? 1 : 0), 0);
}

export function buildDashboardBeltStats(beltRanks: BeltRank[]) {
  let beltCount = 0;
  let tipCount = 0;

  for (const rank of beltRanks) {
    if (rank.is_tip) {
      tipCount += 1;
    } else {
      beltCount += 1;
    }
  }

  return { beltCount, tipCount };
}

export function buildDashboardInactivityStats<T extends { daysInactive: number }>(inactivityRows: T[]) {
  let watch14 = 0;
  let watch30 = 0;
  let watch90 = 0;
  const highestRiskStudents: T[] = [];

  for (const row of inactivityRows) {
    if (row.daysInactive >= 14) {
      watch14 += 1;

      if (highestRiskStudents.length < 5) {
        highestRiskStudents.push(row);
      }
    }

    if (row.daysInactive >= 30) {
      watch30 += 1;
    }

    if (row.daysInactive >= 90) {
      watch90 += 1;
    }
  }

  return { watch14, watch30, watch90, highestRiskStudents };
}

export function buildDashboardNewStudentStats(
  students: Student[],
  today: string,
  lookback14: string,
  lookback30: string,
  lookback90: string,
  yearStart: string
) {
  let new14 = 0;
  let new30 = 0;
  let new90 = 0;
  let newYearToDate = 0;

  for (const student of students) {
    if (student.status !== "active" && student.status !== "trialing" && student.status !== "paused") {
      continue;
    }

    const startDate = dashboardStudentStartDate(student);
    if (startDate > today) {
      continue;
    }

    if (startDate >= lookback14) {
      new14 += 1;
    }

    if (startDate >= lookback30) {
      new30 += 1;
    }

    if (startDate >= lookback90) {
      new90 += 1;
    }

    if (startDate >= yearStart) {
      newYearToDate += 1;
    }
  }

  return { new14, new30, new90, newYearToDate };
}

export function buildDashboardOperationalStats(
  attendance: AttendanceRecord[],
  sessions: ClassSession[],
  lookback30: string,
  today: string
) {
  const attendanceBySession = new Map<string, number>();

  for (const record of attendance) {
    if (record.status === "absent") {
      continue;
    }

    attendanceBySession.set(
      record.session_id,
      (attendanceBySession.get(record.session_id) ?? 0) + 1
    );
  }

  let attendanceWithCapacity = 0;
  let totalCapacity = 0;
  let totalCheckIns = 0;
  let sessionsTracked = 0;
  let sessionsWithCapacity = 0;

  for (const session of sessions) {
    if (
      session.status === "canceled" ||
      session.date < lookback30 ||
      session.date > today
    ) {
      continue;
    }

    const attendees = attendanceBySession.get(session.id) ?? session.attendance_count ?? 0;
    totalCheckIns += attendees;
    sessionsTracked += 1;

    if (session.capacity && session.capacity > 0) {
      attendanceWithCapacity += attendees;
      totalCapacity += session.capacity;
      sessionsWithCapacity += 1;
    }
  }

  return {
    attendanceWithCapacity,
    totalCapacity,
    sessionsTracked,
    sessionsWithCapacity,
    utilizationRate: totalCapacity > 0 ? attendanceWithCapacity / totalCapacity : null,
    averageAttendance: sessionsTracked > 0 ? totalCheckIns / sessionsTracked : 0,
  };
}

export function buildDashboardChurnStats(students: Student[]) {
  let inactiveStudents = 0;
  let canceledStudents = 0;

  for (const student of students) {
    if (student.status === "inactive") {
      inactiveStudents += 1;
    } else if (student.status === "canceled") {
      canceledStudents += 1;
    }
  }

  const churnMarkedStudents = inactiveStudents + canceledStudents;

  return {
    inactiveStudents,
    canceledStudents,
    churnMarkedStudents,
    churnRate: students.length > 0 ? churnMarkedStudents / students.length : null,
  };
}

export function buildDashboardTestReadinessStats(eligibility: EligibilityEntry[]) {
  let readyToTest = 0;
  let needsApproval = 0;

  for (const entry of eligibility) {
    if (entry.is_eligible) {
      readyToTest += 1;
    } else if (entry.classes_met && entry.time_met && entry.needs_approval) {
      needsApproval += 1;
    }
  }

  return { readyToTest, needsApproval };
}

export function buildDashboardRecentStudentRows(
  summaryRows: DashboardSummaryRecentStudent[] | null | undefined,
  students: Student[],
  hasPartialStudentSample: boolean
) {
  if (summaryRows) {
    return summaryRows.map((student) => ({
      id: student.id,
      displayName: student.display_name,
      status: student.status,
      startedOn: student.started_on ?? null,
    }));
  }

  if (hasPartialStudentSample) {
    return [];
  }

  return students.slice(0, 5).map((student) => ({
    id: student.id,
    displayName: `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`.trim(),
    status: student.status,
    startedOn: dashboardStudentStartDate(student),
  }));
}

export interface DashboardProgramBucket {
  programId: string | null;
  label: string;
  activeStudents: number;
  trialingStudents: number;
  activeLeads: number;
  todaySessions: number;
}

export function buildDashboardProgramBuckets(
  programs: Program[],
  programById: Map<string, Program>,
  students: Student[],
  leads: Lead[],
  sessions: ClassSession[],
  today: string
) {
  const rows = new Map<string, DashboardProgramBucket>();

  for (const program of programs.filter((item) => !item.archived_at)) {
    rows.set(program.id, {
      programId: program.id,
      label: program.name,
      activeStudents: 0,
      trialingStudents: 0,
      activeLeads: 0,
      todaySessions: 0,
    });
  }

  const ensureRow = (programId: string | null, fallback: string) => {
    const key = programId || "unassigned";
    const existing = rows.get(key);
    if (existing) {
      return existing;
    }

    const program = programId ? programById.get(programId) : null;
    const row = {
      programId,
      label: program?.name || fallback,
      activeStudents: 0,
      trialingStudents: 0,
      activeLeads: 0,
      todaySessions: 0,
    };
    rows.set(key, row);
    return row;
  };

  for (const student of students) {
    const memberships = student.program_memberships?.filter((membership) => membership.status === "active") ?? [];
    const programIds = memberships.length > 0
      ? memberships.map((membership) => membership.program_id)
      : [student.program_id || null];

    for (const programId of programIds) {
      const row = ensureRow(programId, "No program");
      if (student.status === "active") {
        row.activeStudents += 1;
      } else if (student.status === "trialing") {
        row.trialingStudents += 1;
      }
    }
  }

  for (const lead of leads) {
    if (lead.stage === "closed_lost" || lead.stage === "enrolled") {
      continue;
    }

    ensureRow(lead.program_id || null, lead.program_interest || "No program").activeLeads += 1;
  }

  for (const session of sessions) {
    if (session.date !== today || session.status === "canceled") {
      continue;
    }

    ensureRow(session.program_id || null, "No program").todaySessions += 1;
  }

  return Array.from(rows.values())
    .filter((row) => row.activeStudents > 0 || row.trialingStudents > 0 || row.activeLeads > 0 || row.todaySessions > 0)
    .sort((a, b) =>
      b.activeStudents + b.trialingStudents + b.activeLeads + b.todaySessions -
      (a.activeStudents + a.trialingStudents + a.activeLeads + a.todaySessions)
    )
    .slice(0, 5);
}
