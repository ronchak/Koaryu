"use client";

import { useMemo } from "react";
import { Header } from "@/components/header";
import { ProgramBadge } from "@/components/programs/program-picker";
import { useLeadStore, useProgramStore, useScheduleStore } from "@/lib/store";
import type { LeadSource, LeadStage } from "@/types";
import { BarChart3, Calendar, TrendingUp, Users } from "lucide-react";

const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  inquiry: "Inquiry",
  trial_scheduled: "Trial Scheduled",
  trial_completed: "Trial Completed",
  offer_sent: "Offer Sent",
  enrolled: "Enrolled",
  closed_lost: "Closed Lost",
};

const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  walk_in: "Walk-in",
  referral: "Referral",
  social: "Social",
  search: "Search",
  website: "Website",
  other: "Other",
};

const LEAD_FUNNEL_STAGES = [
  "inquiry",
  "trial_scheduled",
  "trial_completed",
  "offer_sent",
  "enrolled",
] as const satisfies LeadStage[];

/* ─── Helpers ─────────────────────────────────── */

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }

  return `${Math.round(value * 100)}%`;
}

function subtractDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() - days);
  return date.toISOString().split("T")[0];
}

/* ─── Reusable Panel Components ───────────────── */

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
  accent: string;
}) {
  return (
    <div className="bg-surface border border-border p-5">
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-8 h-8 flex items-center justify-center"
          style={{ backgroundColor: `${accent}12` }}
        >
          <Icon className="w-4 h-4" style={{ color: accent }} />
        </div>
        <span className="text-[11px] font-medium uppercase tracking-widest text-text-secondary">
          {label}
        </span>
      </div>
      <p className="text-3xl font-bold text-text-primary font-mono leading-none">{value}</p>
      <p className="text-xs text-muted mt-2 leading-relaxed">{sub}</p>
    </div>
  );
}

function Panel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-surface border border-border p-5 ${className}`}>
      {children}
    </section>
  );
}

function PanelHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {subtitle && (
          <p className="text-xs text-text-secondary mt-1 leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="border border-border bg-surface-raised/40 px-4 py-5 text-sm text-text-secondary">
      {message}
    </div>
  );
}

function StatBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="border border-border bg-surface-raised px-2 py-1 text-xs text-text-secondary">
      {children}
    </span>
  );
}

/* ─── Page ────────────────────────────────────── */

export default function ReportsPage() {
  const { leads } = useLeadStore();
  const { programs } = useProgramStore();
  const { attendance, sessions } = useScheduleStore();
  const today = new Date().toISOString().split("T")[0];
  const lookbackStart = useMemo(() => subtractDays(today, 29), [today]);
  const programById = useMemo(
    () => new Map(programs.map((program) => [program.id, program])),
    [programs]
  );

  const leadMetrics = useMemo(() => {
    const leadStageCounts: Record<LeadStage, number> = {
      inquiry: 0,
      trial_scheduled: 0,
      trial_completed: 0,
      offer_sent: 0,
      enrolled: 0,
      closed_lost: 0,
    };
    const sourceCounts = (Object.keys(LEAD_SOURCE_LABELS) as LeadSource[]).reduce(
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
    const funnelRows = LEAD_FUNNEL_STAGES.map((stage) => ({
      stage,
      label: LEAD_STAGE_LABELS[stage],
      count: leadStageCounts[stage],
      share: activePipelineLeads > 0 ? leadStageCounts[stage] / activePipelineLeads : 0,
    }));
    const sourceRows = (Object.keys(LEAD_SOURCE_LABELS) as LeadSource[])
      .map((source) => {
        const counts = sourceCounts[source];

        return {
          source,
          label: LEAD_SOURCE_LABELS[source],
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
  }, [leads]);

  const attendanceBySession = useMemo(() => {
    const counts = new Map<string, number>();

    for (const record of attendance) {
      if (record.status === "absent") {
        continue;
      }

      counts.set(record.session_id, (counts.get(record.session_id) ?? 0) + 1);
    }

    return counts;
  }, [attendance]);

  const sessionRows = useMemo(() => {
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
  }, [attendanceBySession, lookbackStart, sessions, today]);

  const attendanceMetrics = useMemo(() => {
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
  }, [sessionRows]);

  const sessionIdsInLookback = useMemo(() => {
    const sessionIds = new Set<string>();

    for (const session of sessions) {
      if (session.date >= lookbackStart && session.date <= today) {
        sessionIds.add(session.id);
      }
    }

    return sessionIds;
  }, [lookbackStart, sessions, today]);

  const uniqueAttendees = useMemo(() => {
    const studentIds = new Set<string>();

    for (const record of attendance) {
      if (record.status !== "absent" && sessionIdsInLookback.has(record.session_id)) {
        studentIds.add(record.student_id);
      }
    }

    return studentIds.size;
  }, [attendance, sessionIdsInLookback]);

  const visibleSessionRows = useMemo(() => sessionRows.slice(0, 10), [sessionRows]);

  const programLeadRows = useMemo(() => {
    const rows = new Map<string, {
      programId: string | null;
      label: string;
      total: number;
      active: number;
      enrolled: number;
    }>();

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
  }, [leads, programs]);

  const programAttendanceRows = useMemo(() => {
    const rows = new Map<string, {
      programId: string | null;
      label: string;
      sessions: number;
      attendance: number;
      capacity: number;
    }>();

    for (const session of sessionRows) {
      const programId = session.program_id || null;
      const program = programId ? programById.get(programId) : null;
      const key = programId || "unassigned";
      const row = rows.get(key) ?? {
        programId,
        label: program?.name || "No program",
        sessions: 0,
        attendance: 0,
        capacity: 0,
      };

      row.sessions += 1;
      row.attendance += session.attendees;
      row.capacity += session.capacity ?? 0;
      rows.set(key, row);
    }

    return Array.from(rows.values())
      .sort((a, b) => b.attendance - a.attendance || b.sessions - a.sessions)
      .slice(0, 6);
  }, [programById, sessionRows]);

  return (
    <>
      <Header
        title="Reports"
        description="Live lead funnel, source, and attendance trends for the current studio."
      />

      <div className="flex-1 p-6 sm:p-8">
        <div className="max-w-6xl space-y-6">

          {/* ── Metric Cards ── */}
          <div className="grid gap-px bg-border md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={BarChart3}
              label="Leads Captured"
              value={String(leadMetrics.totalLeads)}
              sub={`${leadMetrics.activePipelineLeads} still active in the funnel`}
              accent="#8B5CF6"
            />
            <MetricCard
              icon={TrendingUp}
              label="Lead Conversion"
              value={formatPercent(
                leadMetrics.totalLeads > 0
                  ? leadMetrics.enrolledLeads / leadMetrics.totalLeads
                  : null
              )}
              sub={`${leadMetrics.enrolledLeads} currently marked enrolled`}
              accent="#22C55E"
            />
            <MetricCard
              icon={Users}
              label="30-Day Attendance"
              value={String(attendanceMetrics.totalAttendance)}
              sub={`${Math.round(attendanceMetrics.averageAttendance || 0)} average check-ins per class`}
              accent="#3B82F6"
            />
            <MetricCard
              icon={Calendar}
              label="Utilization"
              value={formatPercent(attendanceMetrics.utilizationRate)}
              sub={
                attendanceMetrics.sessionsWithCapacity > 0
                  ? `${attendanceMetrics.sessionsWithCapacity} classes with capacity tracking`
                  : "Add class capacities to unlock utilization"
              }
              accent="#F59E0B"
            />
          </div>

          {/* ── Lead Funnel + Lead Sources ── */}
          <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <Panel>
              <PanelHeader
                title="Lead Funnel"
                subtitle="Current leads grouped by pipeline stage."
              >
                <StatBadge>{leadMetrics.leadStageCounts.closed_lost} lost</StatBadge>
              </PanelHeader>

              <div className="space-y-4">
                {leadMetrics.funnelRows.map((row) => (
                  <div key={row.stage}>
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span className="text-text-primary font-medium">{row.label}</span>
                      <span className="font-mono text-text-secondary">{row.count}</span>
                    </div>
                    <div className="h-1.5 bg-surface-raised overflow-hidden">
                      <div
                        className="h-full bg-accent transition-[width] duration-150"
                        style={{ width: `${Math.max(row.share * 100, row.count > 0 ? 10 : 0)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Lead Sources"
                subtitle="Compare volume and enrolled outcomes by acquisition source."
              />

              <div className="divide-y divide-border border-t border-border">
                {leadMetrics.sourceRows.map((row) => (
                  <div
                    key={row.source}
                    className="flex items-start justify-between gap-4 py-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{row.label}</p>
                      <p className="text-xs text-text-secondary mt-1">
                        {row.active} active · {row.enrolled} enrolled
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-base font-mono font-semibold text-text-primary">{row.total}</p>
                      <p className="text-[11px] text-muted mt-0.5">
                        {formatPercent(row.conversionRate)} conv.
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          {/* ── Lead Programs + Program Attendance ── */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Panel>
              <PanelHeader
                title="Lead Programs"
                subtitle="Pipeline demand grouped by selected program."
              />

              {programLeadRows.length === 0 ? (
                <EmptyState message="Program selection will appear here as leads are captured." />
              ) : (
                <div className="divide-y divide-border border-t border-border">
                  {programLeadRows.map((row) => (
                    <div
                      key={row.programId || row.label}
                      className="flex items-start justify-between gap-4 py-4"
                    >
                      <div className="min-w-0">
                        <ProgramBadge
                          program={row.programId ? programById.get(row.programId) : null}
                          fallback={row.label}
                        />
                        <p className="text-xs text-text-secondary mt-2">
                          {row.active} active · {row.enrolled} enrolled
                        </p>
                      </div>
                      <p className="text-base font-mono font-semibold text-text-primary shrink-0">
                        {row.total}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel>
              <PanelHeader
                title="Program Attendance"
                subtitle="Last 30 days of class volume and check-ins by program."
              />

              {programAttendanceRows.length === 0 ? (
                <EmptyState message="Program attendance will appear after classes are scheduled." />
              ) : (
                <div className="divide-y divide-border border-t border-border">
                  {programAttendanceRows.map((row) => (
                    <div
                      key={row.programId || row.label}
                      className="flex items-start justify-between gap-4 py-4"
                    >
                      <div className="min-w-0">
                        <ProgramBadge
                          program={row.programId ? programById.get(row.programId) : null}
                          fallback={row.label}
                        />
                        <p className="text-xs text-text-secondary mt-2">
                          {row.sessions} sessions · {row.capacity > 0 ? `${formatPercent(row.attendance / row.capacity)} utilization` : "No capacity tracked"}
                        </p>
                      </div>
                      <p className="text-base font-mono font-semibold text-text-primary shrink-0">
                        {row.attendance}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          {/* ── Attendance & Utilization Table ── */}
          <Panel>
            <PanelHeader
              title="Attendance & Utilization"
              subtitle="Last 30 days of completed or elapsed classes."
            >
              <div className="flex flex-wrap gap-2">
                <StatBadge>{sessionRows.length} sessions</StatBadge>
                <StatBadge>{uniqueAttendees} unique attendees</StatBadge>
                <StatBadge>
                  {attendanceMetrics.totalCapacity > 0 ? `${attendanceMetrics.totalCapacity} total seats tracked` : "No seat caps yet"}
                </StatBadge>
              </div>
            </PanelHeader>

            {sessionRows.length === 0 ? (
              <EmptyState message="No classes have been scheduled in the last 30 days yet, so attendance and utilization metrics are still warming up." />
            ) : (
              <div className="overflow-x-auto -mx-5">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-y border-border text-left text-[11px] uppercase tracking-widest text-muted">
                      <th className="py-3 pl-5 pr-4 font-medium">Class</th>
                      <th className="py-3 pr-4 font-medium">Date</th>
                      <th className="py-3 pr-4 font-medium">Attendance</th>
                      <th className="py-3 pr-4 font-medium">Capacity</th>
                      <th className="py-3 pr-5 font-medium">Utilization</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSessionRows.map((session) => (
                      <tr
                        key={session.id}
                        className="border-b border-border/50 last:border-0 hover:bg-surface-raised/30 transition-colors"
                      >
                        <td className="py-3.5 pl-5 pr-4 text-text-primary font-medium">
                          {session.name}
                        </td>
                        <td className="py-3.5 pr-4 text-text-secondary">
                          {formatDate(session.date)}
                        </td>
                        <td className="py-3.5 pr-4 font-mono text-text-primary">
                          {session.attendees}
                        </td>
                        <td className="py-3.5 pr-4 font-mono text-text-secondary">
                          {session.capacity ?? "—"}
                        </td>
                        <td className="py-3.5 pr-5 font-mono text-text-secondary">
                          {formatPercent(session.utilization)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
