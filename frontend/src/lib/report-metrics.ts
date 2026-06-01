import type { AttendanceRecord, ClassSession, Lead, LeadSource, LeadStage, Program } from "@/types";

export type ReportSessionMetricRow = {
  attendees: number;
  capacity?: number | null;
};

export type ReportProgramSessionMetricRow = ReportSessionMetricRow & {
  program_id?: string | null;
};

export const REPORT_LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  inquiry: "Inquiry",
  trial_scheduled: "Trial Scheduled",
  trial_completed: "Trial Completed",
  offer_sent: "Offer Sent",
  enrolled: "Enrolled",
  closed_lost: "Closed Lost",
};

export const REPORT_LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  walk_in: "Walk-in",
  referral: "Referral",
  social: "Social",
  search: "Search",
  website: "Website",
  other: "Other",
};

export const REPORT_LEAD_FUNNEL_STAGES = [
  "inquiry",
  "trial_scheduled",
  "trial_completed",
  "offer_sent",
  "enrolled",
] as const satisfies LeadStage[];

export type ReportLeadSourceRow = {
  source: LeadSource;
  label: string;
  total: number;
  active: number;
  enrolled: number;
  conversionRate: number | null;
};

export type ReportLeadFunnelRow = {
  stage: LeadStage;
  label: string;
  count: number;
  share: number;
};

export type ReportProgramLeadRow = {
  programId: string | null;
  label: string;
  total: number;
  active: number;
  enrolled: number;
};

export type ReportSessionRow = ClassSession & {
  attendees: number;
  utilization: number | null;
};

function toReportLocalDateKey(date: Date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatReportDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatReportPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }

  return `${Math.round(value * 100)}%`;
}

export function subtractReportDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() - days);
  return toReportLocalDateKey(date);
}

export function calculateAttendanceMetrics(sessionRows: ReportSessionMetricRow[]) {
  let totalAttendance = 0;
  let totalCapacity = 0;
  let sessionsWithCapacity = 0;

  for (const session of sessionRows) {
    totalAttendance += session.attendees;

    if (session.capacity && session.capacity > 0) {
      totalCapacity += session.capacity;
      sessionsWithCapacity += 1;
    }
  }

  return {
    totalAttendance,
    totalCapacity,
    sessionsWithCapacity,
    utilizationRate: totalCapacity > 0 ? totalAttendance / totalCapacity : null,
    averageAttendance: sessionRows.length > 0 ? totalAttendance / sessionRows.length : 0,
  };
}

export function buildProgramAttendanceRows(
  sessionRows: ReportProgramSessionMetricRow[],
  getProgramLabel: (programId: string | null) => string,
) {
  const rows = new Map<string, {
    programId: string | null;
    label: string;
    sessions: number;
    attendance: number;
    capacity: number;
  }>();

  for (const session of sessionRows) {
    const programId = session.program_id || null;
    const key = programId || "unassigned";
    const row = rows.get(key) ?? {
      programId,
      label: getProgramLabel(programId),
      sessions: 0,
      attendance: 0,
      capacity: 0,
    };

    row.sessions += 1;
    row.attendance += session.attendees;

    if (session.capacity && session.capacity > 0) {
      row.capacity += session.capacity;
    }

    rows.set(key, row);
  }

  return Array.from(rows.values())
    .sort((a, b) => b.attendance - a.attendance || b.sessions - a.sessions)
    .slice(0, 6);
}

export function buildReportLeadMetrics(leads: Lead[]) {
  const leadStageCounts: Record<LeadStage, number> = {
    inquiry: 0,
    trial_scheduled: 0,
    trial_completed: 0,
    offer_sent: 0,
    enrolled: 0,
    closed_lost: 0,
  };
  const sourceCounts = (Object.keys(REPORT_LEAD_SOURCE_LABELS) as LeadSource[]).reduce(
    (counts, source) => {
      counts[source] = { total: 0, active: 0, enrolled: 0 };
      return counts;
    },
    {} as Record<LeadSource, { total: number; active: number; enrolled: number }>
  );

  for (const lead of leads) {
    leadStageCounts[lead.stage] += 1;

    const sourceCount = sourceCounts[lead.source];
    sourceCount.total += 1;

    if (lead.stage !== "closed_lost") {
      sourceCount.active += 1;
    }

    if (lead.stage === "enrolled") {
      sourceCount.enrolled += 1;
    }
  }

  const totalLeads = leads.length;
  const enrolledLeads = leadStageCounts.enrolled;
  const activePipelineLeads = totalLeads - leadStageCounts.closed_lost;
  const funnelRows: ReportLeadFunnelRow[] = REPORT_LEAD_FUNNEL_STAGES.map((stage) => ({
    stage,
    label: REPORT_LEAD_STAGE_LABELS[stage],
    count: leadStageCounts[stage],
    share: activePipelineLeads > 0 ? leadStageCounts[stage] / activePipelineLeads : 0,
  }));
  const sourceRows: ReportLeadSourceRow[] = (Object.keys(REPORT_LEAD_SOURCE_LABELS) as LeadSource[])
    .map((source) => {
      const counts = sourceCounts[source];

      return {
        source,
        label: REPORT_LEAD_SOURCE_LABELS[source],
        total: counts.total,
        active: counts.active,
        enrolled: counts.enrolled,
        conversionRate: counts.total > 0 ? counts.enrolled / counts.total : null,
      };
    })
    .sort((a, b) => b.total - a.total);

  return {
    leadStageCounts,
    totalLeads,
    enrolledLeads,
    activePipelineLeads,
    funnelRows,
    sourceRows,
  };
}

export function buildAttendanceBySession(attendance: AttendanceRecord[]) {
  const counts = new Map<string, number>();

  for (const record of attendance) {
    if (record.status === "absent") {
      continue;
    }

    counts.set(record.session_id, (counts.get(record.session_id) ?? 0) + 1);
  }

  return counts;
}

export function buildReportSessionRows({
  attendanceBySession,
  lookbackStart,
  sessions,
  today,
}: {
  attendanceBySession: Map<string, number>;
  lookbackStart: string;
  sessions: ClassSession[];
  today: string;
}): ReportSessionRow[] {
  return sessions
    .filter(
      (session) =>
        session.status !== "canceled" &&
        session.date >= lookbackStart &&
        session.date <= today
    )
    .map((session) => {
      const attendees = attendanceBySession.get(session.id) ?? session.attendance_count ?? 0;
      const capacity = session.capacity ?? null;

      return {
        ...session,
        attendees,
        utilization: capacity && capacity > 0 ? attendees / capacity : null,
      };
    })
    .sort((a, b) => {
      if (a.date === b.date) {
        return b.start_time.localeCompare(a.start_time);
      }

      return b.date.localeCompare(a.date);
    });
}

export function countUniqueReportAttendees({
  attendance,
  lookbackStart,
  sessions,
  today,
}: {
  attendance: AttendanceRecord[];
  sessions: ClassSession[];
  lookbackStart: string;
  today: string;
}) {
  const sessionIds = new Set(
    sessions
      .filter((session) => session.date >= lookbackStart && session.date <= today)
      .map((session) => session.id)
  );
  const studentIds = new Set<string>();

  for (const record of attendance) {
    if (record.status !== "absent" && sessionIds.has(record.session_id)) {
      studentIds.add(record.student_id);
    }
  }

  return studentIds.size;
}

export function buildReportProgramLeadRows({
  leads,
  programs,
}: {
  leads: Lead[];
  programs: Program[];
}): ReportProgramLeadRow[] {
  const rows = new Map<string, ReportProgramLeadRow>();

  for (const program of programs.filter((item) => !item.archived_at)) {
    rows.set(program.id, {
      programId: program.id,
      label: program.name,
      total: 0,
      active: 0,
      enrolled: 0,
    });
  }

  for (const lead of leads) {
    const programId = lead.program_id || null;
    const key = programId || "unassigned";
    const row = rows.get(key) ?? {
      programId,
      label: lead.program_interest || "No program",
      total: 0,
      active: 0,
      enrolled: 0,
    };

    row.total += 1;
    if (lead.stage !== "closed_lost") {
      row.active += 1;
    }
    if (lead.stage === "enrolled") {
      row.enrolled += 1;
    }
    rows.set(key, row);
  }

  return Array.from(rows.values())
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
    .slice(0, 6);
}

export function buildReportsPageModel({
  attendance,
  leads,
  programs,
  sessions,
  today = toReportLocalDateKey(),
}: {
  attendance: AttendanceRecord[];
  leads: Lead[];
  programs: Program[];
  sessions: ClassSession[];
  today?: string;
}) {
  const lookbackStart = subtractReportDays(today, 29);
  const programById = new Map(programs.map((program) => [program.id, program]));
  const leadMetrics = buildReportLeadMetrics(leads);
  const attendanceBySession = buildAttendanceBySession(attendance);
  const sessionRows = buildReportSessionRows({
    attendanceBySession,
    lookbackStart,
    sessions,
    today,
  });
  const attendanceMetrics = calculateAttendanceMetrics(sessionRows);
  const visibleSessionRows = sessionRows.slice(0, 10);
  const programLeadRows = buildReportProgramLeadRows({ leads, programs });
  const programAttendanceRows = buildProgramAttendanceRows(
    sessionRows,
    (programId) => (programId ? programById.get(programId)?.name : null) || "No program",
  );

  return {
    attendanceMetrics,
    leadMetrics,
    lookbackStart,
    programAttendanceRows,
    programById,
    programLeadRows,
    sessionRows,
    today,
    uniqueAttendees: countUniqueReportAttendees({ attendance, lookbackStart, sessions, today }),
    visibleSessionRows,
  };
}
