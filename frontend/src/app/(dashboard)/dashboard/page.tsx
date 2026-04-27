"use client";

import { Header } from "@/components/header";
import { ProgramBadge } from "@/components/programs/program-picker";
import { toLocalDateKey } from "@/lib/date";
import { buildStudentInactivityRows, isStudentOnHoldNow } from "@/lib/student-insights";
import {
  useBeltStore,
  useLeadStore,
  useProgramStore,
  useScheduleStore,
  useStudentStore,
  useStudioStore,
} from "@/lib/store";
import {
  ArrowRight,
  Award,
  Calendar,
  Clock,
  PauseCircle,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

/* ─── Quick actions config ────────────────────── */

const QUICK_ACTIONS = [
  { label: "Add Student", href: "/students", icon: Users },
  { label: "Import CSV", href: "/students/import", icon: Clock },
  { label: "View Leads", href: "/leads", icon: UserPlus },
  { label: "Reports", href: "/reports", icon: TrendingUp },
];

/* ─── Helpers ─────────────────────────────────── */

function formatDate(value?: string) {
  if (!value) return "—";

  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/* ─── Stat Card ───────────────────────────────── */

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  href,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
  accent?: string;
}) {
  const content = (
    <div
      className={`
        group relative bg-surface border border-border p-5
        transition-colors duration-150
        ${href ? "hover:border-[color:var(--accent)]/30 cursor-pointer" : ""}
      `}
    >
      {/* Accent top edge — 2px line, visible on hover */}
      {href && (
        <span
          className="absolute top-0 left-0 right-0 h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-150"
          style={{ backgroundColor: accent || "var(--accent)" }}
        />
      )}

      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-8 h-8 flex items-center justify-center"
          style={{ backgroundColor: accent ? `${accent}12` : "var(--surface-raised)" }}
        >
          <Icon className="w-4 h-4" style={{ color: accent || "var(--text-secondary)" }} />
        </div>
        <span className="text-[11px] text-muted font-medium uppercase tracking-widest">
          {label}
        </span>
      </div>
      <p className="text-3xl font-bold text-text-primary font-mono leading-none">{value}</p>
      {sub && <p className="text-xs text-muted mt-2 leading-relaxed">{sub}</p>}
    </div>
  );

  if (href) return <Link href={href}>{content}</Link>;
  return content;
}

/* ─── Inactivity Compact Bar ──────────────────── */

function InactivityBar({
  watch14,
  watch30,
  watch45,
  onHold,
}: {
  watch14: number;
  watch30: number;
  watch45: number;
  onHold: number;
}) {
  const segments = [
    { label: "14+ days", value: watch14, color: "#F59E0B", href: "/students?inactiveDays=14" },
    { label: "30+ days", value: watch30, color: "#EF4444", href: "/students?inactiveDays=30" },
    { label: "45+ days", value: watch45, color: "#B91C1C", href: "/students?inactiveDays=45" },
    { label: "On hold",  value: onHold,  color: "#64748B", href: "/students" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 border border-border bg-surface divide-x divide-border">
      {segments.map((seg) => (
        <Link
          key={seg.label}
          href={seg.href}
          className="group relative flex items-center gap-3 px-4 py-3.5 hover:bg-surface-raised/50 transition-colors"
        >
          <span
            className="absolute top-0 left-0 right-0 h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-150"
            style={{ backgroundColor: seg.color }}
          />
          <span
            className="w-2 h-2 shrink-0"
            style={{ backgroundColor: seg.color }}
          />
          <div className="min-w-0">
            <p className="text-lg font-mono font-bold text-text-primary leading-none">
              {seg.value}
            </p>
            <p className="text-[11px] text-muted mt-1 uppercase tracking-wide">
              {seg.label}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}

/* ─── Panel wrapper ───────────────────────────── */

function Panel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-surface border border-border p-5 ${className}`}>
      {children}
    </div>
  );
}

function PanelHeader({
  title,
  subtitle,
  href,
  linkLabel = "View all",
}: {
  title: string;
  subtitle?: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {subtitle && (
          <p className="text-xs text-text-secondary mt-1 leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {href && (
        <Link
          href={href}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover shrink-0 transition-colors"
        >
          {linkLabel}
          <ArrowRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}

/* ─── Page ────────────────────────────────────── */

export default function DashboardPage() {
  const { studioName } = useStudioStore();
  const { students } = useStudentStore();
  const { leads } = useLeadStore();
  const { programs } = useProgramStore();
  const { sessions, attendance } = useScheduleStore();
  const { beltRanks, subRankTerm } = useBeltStore();
  const today = toLocalDateKey();
  const programById = useMemo(
    () => new Map(programs.map((program) => [program.id, program])),
    [programs]
  );

  const studentStats = useMemo(() => {
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

      if (isStudentOnHoldNow(student, today)) {
        onHoldStudents += 1;
      }
    }

    return {
      totalStudents: students.length,
      activeStudents,
      trialingStudents,
      onHoldStudents,
    };
  }, [students, today]);

  const leadStats = useMemo(() => {
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
  }, [leads, today]);

  const todaySessions = useMemo(
    () => sessions.reduce((count, session) => count + (session.date === today ? 1 : 0), 0),
    [sessions, today]
  );

  const beltStats = useMemo(() => {
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
  }, [beltRanks]);

  const inactivityRows = useMemo(
    () => buildStudentInactivityRows(students, sessions, attendance, today),
    [attendance, sessions, students, today]
  );

  const inactivityStats = useMemo(() => {
    let watch14 = 0;
    let watch30 = 0;
    let watch45 = 0;
    const highestRiskStudents: typeof inactivityRows = [];

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

      if (row.daysInactive >= 45) {
        watch45 += 1;
      }
    }

    return { watch14, watch30, watch45, highestRiskStudents };
  }, [inactivityRows]);

  const recentStudents = useMemo(() => students.slice(0, 5), [students]);

  const programBuckets = useMemo(() => {
    const rows = new Map<string, {
      programId: string | null;
      label: string;
      activeStudents: number;
      trialingStudents: number;
      activeLeads: number;
      todaySessions: number;
    }>();

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
  }, [leads, programById, programs, sessions, students, today]);

  return (
    <>
      <Header
        title="Dashboard"
        description={studioName || "Your studio at a glance."}
      />
      <div className="flex-1 p-6 sm:p-8">
        <div className="max-w-6xl">

          {/* ── Primary Stats ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border mb-6">
            <StatCard
              icon={Users}
              label="Total Students"
              value={studentStats.totalStudents}
              sub={`${studentStats.activeStudents} active · ${studentStats.trialingStudents} trialing`}
              href="/students"
              accent="#3B82F6"
            />
            <StatCard
              icon={UserPlus}
              label="Active Leads"
              value={leadStats.activeLeads}
              sub={`${leadStats.dueTodayLeads} follow-ups due · ${leadStats.enrolledLeads} enrolled`}
              href="/leads"
              accent="#8B5CF6"
            />
            <StatCard
              icon={Calendar}
              label="Today's Classes"
              value={todaySessions}
              sub={
                todaySessions === 0
                  ? "No classes scheduled"
                  : `${todaySessions} session${todaySessions > 1 ? "s" : ""} today`
              }
              href="/schedule"
              accent="#F59E0B"
            />
            <StatCard
              icon={Award}
              label="Belt Ranks"
              value={beltStats.beltCount}
              sub={`${beltStats.tipCount} ${subRankTerm.toLowerCase()}s configured`}
              href="/belt-tracker"
              accent="#22C55E"
            />
          </div>

          {/* ── Inactivity & On Hold — compact bar ── */}
          <div className="mb-6">
            <InactivityBar
              watch14={inactivityStats.watch14}
              watch30={inactivityStats.watch30}
              watch45={inactivityStats.watch45}
              onHold={studentStats.onHoldStudents}
            />
          </div>

          {/* ── Inactivity Watch + Quick Actions ── */}
          <div className="grid gap-px bg-border lg:grid-cols-[1.2fr_0.8fr] mb-6">
            <Panel>
              <PanelHeader
                title="Inactivity Watch"
                subtitle="Active and trialing students only. Current holds are excluded automatically."
                href="/reports"
                linkLabel="Open reports"
              />

              {inactivityStats.highestRiskStudents.length === 0 ? (
                <div className="border border-border bg-surface-raised/40 px-4 py-5 text-sm text-text-secondary">
                  No active students have crossed the 14-day inactivity threshold right now.
                </div>
              ) : (
                <div className="space-y-1">
                  {inactivityStats.highestRiskStudents.map((row) => (
                    <Link
                      key={row.student.id}
                      href={`/students/${row.student.id}`}
                      className="group relative flex items-center justify-between gap-4 border border-border bg-surface-raised/40 px-4 py-3 hover:border-[color:var(--accent)]/30 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary">
                          {row.student.preferred_name || row.student.legal_first_name} {row.student.legal_last_name}
                        </p>
                        <p className="text-xs text-text-secondary mt-1">
                          {row.lastAttendanceDate
                            ? `Last attended ${formatDate(row.lastAttendanceDate)}`
                            : `No attendance yet · member since ${formatDate(row.referenceDate)}`}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-lg font-mono font-semibold text-text-primary">{row.daysInactive}</p>
                        <p className="text-[10px] text-muted uppercase tracking-widest">days</p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Panel>

            <Panel>
              <PanelHeader title="Quick Actions" />
              <div className="grid grid-cols-2 gap-2">
                {QUICK_ACTIONS.map((action) => (
                  <Link
                    key={action.label}
                    href={action.href}
                    className="group relative flex items-center gap-2.5 px-4 py-3 bg-surface-raised/60 border border-border hover:border-[color:var(--accent)]/30 transition-colors text-sm text-text-secondary hover:text-text-primary"
                  >
                    <action.icon className="w-3.5 h-3.5 text-muted group-hover:text-accent transition-colors" />
                    {action.label}
                  </Link>
                ))}
              </div>
            </Panel>
          </div>

          {/* ── Program Buckets ── */}
          <Panel className="mb-6">
            <PanelHeader
              title="Program Buckets"
              subtitle="Active students, open leads, and today's classes grouped by program."
              href="/reports"
              linkLabel="View reports"
            />

            {programBuckets.length === 0 ? (
              <div className="border border-border bg-surface-raised/40 px-4 py-5 text-sm text-text-secondary">
                Program activity will appear here once students, leads, or classes are assigned.
              </div>
            ) : (
              <div className="grid gap-px bg-border md:grid-cols-2 xl:grid-cols-3">
                {programBuckets.map((row) => (
                  <div
                    key={row.programId || row.label}
                    className="bg-surface px-4 py-4"
                  >
                    <ProgramBadge
                      program={row.programId ? programById.get(row.programId) : null}
                      fallback={row.label}
                    />
                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <p className="font-mono text-base font-semibold text-text-primary">
                          {row.activeStudents + row.trialingStudents}
                        </p>
                        <p className="text-muted mt-0.5">students</p>
                      </div>
                      <div>
                        <p className="font-mono text-base font-semibold text-text-primary">{row.activeLeads}</p>
                        <p className="text-muted mt-0.5">leads</p>
                      </div>
                      <div>
                        <p className="font-mono text-base font-semibold text-text-primary">{row.todaySessions}</p>
                        <p className="text-muted mt-0.5">today</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* ── Recent Students ── */}
          {students.length > 0 && (
            <Panel>
              <PanelHeader
                title="Recent Students"
                href="/students"
              />
              <div className="divide-y divide-border border-t border-border">
                {recentStudents.map((student) => (
                  <Link
                    key={student.id}
                    href={`/students/${student.id}`}
                    className="flex items-center justify-between py-3 hover:bg-surface-raised/40 transition-colors -mx-5 px-5"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-7 h-7 bg-surface-raised border border-border flex items-center justify-center flex-shrink-0">
                        <span className="text-[10px] font-medium text-text-secondary">
                          {student.legal_first_name[0]}
                          {student.legal_last_name[0]}
                        </span>
                      </div>
                      <span className="text-sm text-text-primary truncate">
                        {student.preferred_name || student.legal_first_name} {student.legal_last_name}
                      </span>
                    </div>
                    <span
                      className={`text-[11px] px-2 py-0.5 font-medium uppercase tracking-wide ${
                        student.status === "active"
                          ? "text-success bg-success/10"
                          : student.status === "trialing"
                            ? "text-accent bg-accent/10"
                            : student.status === "paused"
                              ? "text-warning bg-warning/10"
                              : "text-muted bg-surface-raised"
                      }`}
                    >
                      {student.status}
                    </span>
                  </Link>
                ))}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
