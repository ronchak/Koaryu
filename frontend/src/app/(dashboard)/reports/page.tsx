"use client";

import { useMemo } from "react";
import { Header } from "@/components/header";
import { useLeadStore, useScheduleStore } from "@/lib/store";
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
    <div className="rounded-[6px] border border-border bg-surface p-5">
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-9 h-9 rounded-[8px] flex items-center justify-center"
          style={{ backgroundColor: `${accent}15` }}
        >
          <Icon className="w-4 h-4" style={{ color: accent }} />
        </div>
        <span className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          {label}
        </span>
      </div>
      <p className="text-2xl font-bold text-text-primary font-mono">{value}</p>
      <p className="text-xs text-muted mt-1">{sub}</p>
    </div>
  );
}

export default function ReportsPage() {
  const { leads } = useLeadStore();
  const { attendance, sessions } = useScheduleStore();
  const today = new Date().toISOString().split("T")[0];
  const lookbackStart = subtractDays(today, 29);

  const leadStageCounts = useMemo(() => {
    const counts: Record<LeadStage, number> = {
      inquiry: 0,
      trial_scheduled: 0,
      trial_completed: 0,
      offer_sent: 0,
      enrolled: 0,
      closed_lost: 0,
    };

    for (const lead of leads) {
      counts[lead.stage] += 1;
    }

    return counts;
  }, [leads]);

  const totalLeads = leads.length;
  const enrolledLeads = leadStageCounts.enrolled;
  const activePipelineLeads = totalLeads - leadStageCounts.closed_lost;
  const funnelRows = (["inquiry", "trial_scheduled", "trial_completed", "offer_sent", "enrolled"] as LeadStage[])
    .map((stage) => ({
      stage,
      label: LEAD_STAGE_LABELS[stage],
      count: leadStageCounts[stage],
      share: activePipelineLeads > 0 ? leadStageCounts[stage] / activePipelineLeads : 0,
    }));

  const sourceRows = useMemo(
    () =>
      (Object.keys(LEAD_SOURCE_LABELS) as LeadSource[])
        .map((source) => {
          const leadsForSource = leads.filter((lead) => lead.source === source);
          const enrolled = leadsForSource.filter((lead) => lead.stage === "enrolled").length;

          return {
            source,
            label: LEAD_SOURCE_LABELS[source],
            total: leadsForSource.length,
            active: leadsForSource.filter((lead) => lead.stage !== "closed_lost").length,
            enrolled,
            conversionRate: leadsForSource.length > 0 ? enrolled / leadsForSource.length : null,
          };
        })
        .sort((a, b) => b.total - a.total),
    [leads]
  );

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

  const totalAttendance = sessionRows.reduce((sum, session) => sum + session.attendees, 0);
  const totalCapacity = sessionRows.reduce(
    (sum, session) => sum + (session.capacity && session.capacity > 0 ? session.capacity : 0),
    0
  );
  const sessionsWithCapacity = sessionRows.filter(
    (session) => session.capacity && session.capacity > 0
  ).length;
  const utilizationRate = totalCapacity > 0 ? totalAttendance / totalCapacity : null;
  const averageAttendance = sessionRows.length > 0 ? totalAttendance / sessionRows.length : 0;
  const uniqueAttendees = new Set(
    attendance
      .filter((record) => {
        const session = sessions.find((candidate) => candidate.id === record.session_id);
        if (!session || record.status === "absent") {
          return false;
        }

        return session.date >= lookbackStart && session.date <= today;
      })
      .map((record) => record.student_id)
  ).size;

  return (
    <>
      <Header
        title="Reports"
        description="Live lead funnel, source, and attendance trends for the current studio."
      />

      <div className="flex-1 p-8">
        <div className="max-w-6xl space-y-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={BarChart3}
              label="Leads Captured"
              value={String(totalLeads)}
              sub={`${activePipelineLeads} still active in the funnel`}
              accent="#8B5CF6"
            />
            <MetricCard
              icon={TrendingUp}
              label="Lead Conversion"
              value={formatPercent(totalLeads > 0 ? enrolledLeads / totalLeads : null)}
              sub={`${enrolledLeads} currently marked enrolled`}
              accent="#22C55E"
            />
            <MetricCard
              icon={Users}
              label="30-Day Attendance"
              value={String(totalAttendance)}
              sub={`${Math.round(averageAttendance || 0)} average check-ins per class`}
              accent="#3B82F6"
            />
            <MetricCard
              icon={Calendar}
              label="Utilization"
              value={formatPercent(utilizationRate)}
              sub={
                sessionsWithCapacity > 0
                  ? `${sessionsWithCapacity} classes with capacity tracking`
                  : "Add class capacities to unlock utilization"
              }
              accent="#F59E0B"
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <section className="rounded-[6px] border border-border bg-surface p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-medium text-text-primary">Lead Funnel</h2>
                  <p className="text-xs text-text-secondary mt-1">
                    Current leads grouped by pipeline stage.
                  </p>
                </div>
                <span className="rounded-[4px] border border-border bg-surface-raised px-2 py-1 text-xs text-text-secondary">
                  {leadStageCounts.closed_lost} lost
                </span>
              </div>

              <div className="space-y-3">
                {funnelRows.map((row) => (
                  <div key={row.stage}>
                    <div className="flex items-center justify-between text-sm mb-1.5">
                      <span className="text-text-primary">{row.label}</span>
                      <span className="font-mono text-text-secondary">{row.count}</span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-raised overflow-hidden">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${Math.max(row.share * 100, row.count > 0 ? 10 : 0)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[6px] border border-border bg-surface p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-text-primary">Lead Sources</h2>
                <p className="text-xs text-text-secondary mt-1">
                  Compare volume and enrolled outcomes by acquisition source.
                </p>
              </div>

              <div className="space-y-3">
                {sourceRows.map((row) => (
                  <div
                    key={row.source}
                    className="rounded-[6px] border border-border bg-surface-raised/60 px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-text-primary">{row.label}</p>
                        <p className="text-xs text-text-secondary mt-1">
                          {row.active} active · {row.enrolled} enrolled
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-mono text-text-primary">{row.total}</p>
                        <p className="text-xs text-muted">
                          {formatPercent(row.conversionRate)} enrolled
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="rounded-[6px] border border-border bg-surface p-5">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between mb-4">
              <div>
                <h2 className="text-sm font-medium text-text-primary">
                  Attendance & Utilization
                </h2>
                <p className="text-xs text-text-secondary mt-1">
                  Last 30 days of completed or elapsed classes.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-[4px] border border-border bg-surface-raised px-2 py-1 text-text-secondary">
                  {sessionRows.length} sessions
                </span>
                <span className="rounded-[4px] border border-border bg-surface-raised px-2 py-1 text-text-secondary">
                  {uniqueAttendees} unique attendees
                </span>
                <span className="rounded-[4px] border border-border bg-surface-raised px-2 py-1 text-text-secondary">
                  {totalCapacity > 0 ? `${totalCapacity} total seats tracked` : "No seat caps yet"}
                </span>
              </div>
            </div>

            {sessionRows.length === 0 ? (
              <div className="rounded-[6px] border border-border bg-surface-raised/60 px-4 py-5 text-sm text-text-secondary">
                No classes have been scheduled in the last 30 days yet, so attendance and utilization metrics are still warming up.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                      <th className="py-2 pr-4 font-medium">Class</th>
                      <th className="py-2 pr-4 font-medium">Date</th>
                      <th className="py-2 pr-4 font-medium">Attendance</th>
                      <th className="py-2 pr-4 font-medium">Capacity</th>
                      <th className="py-2 font-medium">Utilization</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionRows.slice(0, 10).map((session) => (
                      <tr key={session.id} className="border-b border-border/60 last:border-0">
                        <td className="py-3 pr-4 text-text-primary">{session.name}</td>
                        <td className="py-3 pr-4 text-text-secondary">
                          {formatDate(session.date)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-text-primary">
                          {session.attendees}
                        </td>
                        <td className="py-3 pr-4 font-mono text-text-secondary">
                          {session.capacity ?? "—"}
                        </td>
                        <td className="py-3 font-mono text-text-secondary">
                          {formatPercent(session.utilization)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
