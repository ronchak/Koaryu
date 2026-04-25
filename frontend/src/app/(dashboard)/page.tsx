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

const QUICK_ACTIONS = [
  { label: "Add Student", href: "/students", icon: Users },
  { label: "Import CSV", href: "/students/import", icon: Clock },
  { label: "View Leads", href: "/leads", icon: UserPlus },
  { label: "Reports", href: "/reports", icon: TrendingUp },
];

function formatDate(value?: string) {
  if (!value) return "—";

  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

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
      className={`bg-surface border border-border rounded-[6px] p-5 transition-colors ${
        href ? "hover:border-accent/40 cursor-pointer" : ""
      }`}
    >
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-8 h-8 rounded-[6px] flex items-center justify-center"
          style={{ backgroundColor: accent ? `${accent}15` : "var(--surface-raised)" }}
        >
          <Icon className="w-4 h-4" style={{ color: accent || "var(--text-secondary)" }} />
        </div>
        <span className="text-xs text-muted font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-2xl font-bold text-text-primary font-mono">{value}</p>
      {sub && <p className="text-xs text-muted mt-1">{sub}</p>}
    </div>
  );

  if (href) return <Link href={href}>{content}</Link>;
  return content;
}

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
      <div className="flex-1 p-8">
        <div className="max-w-5xl">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
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

          <div className="grid gap-4 lg:grid-cols-4 mb-4">
            <StatCard
              icon={Clock}
              label="14+ Days Inactive"
              value={inactivityStats.watch14}
              sub="Students who may need a quick outreach touch"
              href="/students?inactiveDays=14"
              accent="#F59E0B"
            />
            <StatCard
              icon={Clock}
              label="30+ Days Inactive"
              value={inactivityStats.watch30}
              sub="Likely at-risk if they were attending regularly"
              href="/students?inactiveDays=30"
              accent="#EF4444"
            />
            <StatCard
              icon={Clock}
              label="45+ Days Inactive"
              value={inactivityStats.watch45}
              sub="Highest urgency follow-up list"
              href="/students?inactiveDays=45"
              accent="#B91C1C"
            />
            <StatCard
              icon={PauseCircle}
              label="On Hold"
              value={studentStats.onHoldStudents}
              sub="Excluded from inactivity cards until their hold ends"
              href="/students"
              accent="#64748B"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="bg-surface border border-border rounded-[6px] p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-medium text-text-primary">Inactivity Watch</h3>
                  <p className="text-xs text-text-secondary mt-1">
                    Active and trialing students only. Current holds are excluded automatically.
                  </p>
                </div>
                <Link href="/reports" className="text-xs text-accent hover:text-accent-hover">
                  Open reports →
                </Link>
              </div>

              {inactivityStats.highestRiskStudents.length === 0 ? (
                <div className="rounded-[6px] border border-border bg-surface-raised/60 px-4 py-5 text-sm text-text-secondary">
                  No active students have crossed the 14-day inactivity threshold right now.
                </div>
              ) : (
                <div className="space-y-2">
                  {inactivityStats.highestRiskStudents.map((row) => (
                    <Link
                      key={row.student.id}
                      href={`/students/${row.student.id}`}
                      className="flex items-center justify-between gap-4 rounded-[6px] border border-border/70 bg-surface-raised/60 px-4 py-3 hover:border-accent/40 transition-colors"
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
                      <div className="text-right">
                        <p className="text-lg font-mono text-text-primary">{row.daysInactive}</p>
                        <p className="text-[11px] text-muted uppercase tracking-wide">days inactive</p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-surface border border-border rounded-[6px] p-5">
              <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5 text-muted" />
                Quick Actions
              </h3>
              <div className="grid grid-cols-2 gap-3">
                {QUICK_ACTIONS.map((action) => (
                  <Link
                    key={action.label}
                    href={action.href}
                    className="flex items-center gap-2.5 px-4 py-3 bg-surface-raised border border-border rounded-[6px] hover:border-accent/40 transition-colors text-sm text-text-secondary hover:text-text-primary"
                  >
                    <action.icon className="w-3.5 h-3.5 text-muted" />
                    {action.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-[6px] p-5 mt-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-medium text-text-primary">Program Buckets</h3>
                <p className="text-xs text-text-secondary mt-1">
                  Active students, open leads, and today&apos;s classes grouped by program.
                </p>
              </div>
              <Link href="/reports" className="text-xs text-accent hover:text-accent-hover">
                View reports →
              </Link>
            </div>

            {programBuckets.length === 0 ? (
              <div className="rounded-[6px] border border-border bg-surface-raised/60 px-4 py-5 text-sm text-text-secondary">
                Program activity will appear here once students, leads, or classes are assigned.
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {programBuckets.map((row) => (
                  <div
                    key={row.programId || row.label}
                    className="rounded-[6px] border border-border bg-surface-raised/60 px-4 py-3"
                  >
                    <ProgramBadge
                      program={row.programId ? programById.get(row.programId) : null}
                      fallback={row.label}
                    />
                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <p className="font-mono text-text-primary">
                          {row.activeStudents + row.trialingStudents}
                        </p>
                        <p className="text-muted">students</p>
                      </div>
                      <div>
                        <p className="font-mono text-text-primary">{row.activeLeads}</p>
                        <p className="text-muted">leads</p>
                      </div>
                      <div>
                        <p className="font-mono text-text-primary">{row.todaySessions}</p>
                        <p className="text-muted">today</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {students.length > 0 && (
            <div className="bg-surface border border-border rounded-[6px] p-5 mt-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-text-primary">Recent Students</h3>
                <Link href="/students" className="text-xs text-accent hover:text-accent-hover">
                  View all →
                </Link>
              </div>
              <div className="space-y-2">
                {recentStudents.map((student) => (
                  <Link
                    key={student.id}
                    href={`/students/${student.id}`}
                    className="flex items-center justify-between px-3 py-2 rounded-[6px] hover:bg-surface-raised transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-6 h-6 rounded-full bg-surface-raised border border-border flex items-center justify-center flex-shrink-0">
                        <span className="text-[10px] font-medium text-text-secondary">
                          {student.legal_first_name[0]}
                          {student.legal_last_name[0]}
                        </span>
                      </div>
                      <span className="text-sm text-text-primary">
                        {student.preferred_name || student.legal_first_name} {student.legal_last_name}
                      </span>
                    </div>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-[4px] capitalize ${
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
            </div>
          )}
        </div>
      </div>
    </>
  );
}
