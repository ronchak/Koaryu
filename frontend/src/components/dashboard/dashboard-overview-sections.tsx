"use client";

import Link from "next/link";
import {
  ArrowRight,
  Award,
  Calendar,
  Clock,
  CreditCard,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";

import {
  type MetricSegment,
  MetricStripSection,
  Panel,
  PanelHeader,
} from "@/components/dashboard/dashboard-page-sections";
import { ProgramBadge } from "@/components/programs/program-picker";
import {
  OverviewActionList,
  OverviewMetricCard,
  OverviewPanel,
  OverviewPanelHeader,
  SetupStepList,
  type OverviewAction,
  type SetupStep,
} from "@/components/ui/overview";
import { crmLinkPrefetch } from "@/lib/constants";
import type { DashboardProgramBucket } from "@/lib/dashboard-page-model";
import { formatCount, formatDate, sampledDetailText } from "@/lib/dashboard-page-utils";
import type { StudentInactivityRow } from "@/lib/student-insights";
import type { Program } from "@/types";

const QUICK_ACTIONS = [
  { label: "Add Student", href: "/students", icon: Users },
  { label: "Import CSV", href: "/students/import", icon: Clock },
  { label: "View Leads", href: "/leads", icon: UserPlus },
  { label: "Reports", href: "/reports", icon: TrendingUp },
];

type StudentStats = {
  totalStudents: number;
  activeStudents: number;
  trialingStudents: number;
  onHoldStudents: number;
};

type LeadStats = {
  activeLeads: number;
  enrolledLeads: number;
  dueTodayLeads: number;
};

type InactivityStats = {
  watch14: number;
  watch30: number;
  watch90: number;
  highestRiskStudents: StudentInactivityRow[];
};

type TestReadinessStats = {
  readyToTest: number;
  needsApproval: number;
};

type BillingSummary = {
  paymentAttentionCount: number | null;
  hasPlans: boolean | null;
  paymentsReady: boolean | null;
};

export type DashboardOwnerBrief = {
  tone: "danger" | "warning" | "success";
  label: string;
  primaryAction: OverviewAction | null;
  summary: string;
  setupCopy: string;
};

type RecentStudentRow = {
  id: string;
  displayName: string;
  status: string;
};

export function DashboardLoadingPanel() {
  return (
    <Panel>
      <PanelHeader
        title="Loading Dashboard"
        subtitle="Preparing the first roster, lead, program, and belt snapshot."
      />
      <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
        {["Students", "Leads", "Classes", "Belts"].map((label) => (
          <div key={label} className="bg-surface px-4 py-4">
            <div className="h-3 w-20 bg-surface-raised" />
            <div className="mt-4 h-8 w-14 bg-surface-raised" />
            <div className="mt-3 h-3 w-28 bg-surface-raised" />
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function DashboardOwnerBriefPanel({
  ownerBrief,
  todayLabel,
  todayActions,
  setupSteps,
}: {
  ownerBrief: DashboardOwnerBrief;
  todayLabel: string;
  todayActions: OverviewAction[];
  setupSteps: SetupStep[];
}) {
  return (
    <OverviewPanel className="mb-6">
      <div className="relative overflow-hidden border-b border-border px-4 py-5 sm:px-5">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-accent/70" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,color-mix(in_srgb,var(--surface-raised)_72%,transparent),transparent_62%)]" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Owner brief · {todayLabel}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold leading-tight text-text-primary">Run the studio with a clean morning read.</h2>
              <span className={`rounded-[4px] border px-2 py-1 text-xs font-medium ${
                ownerBrief.tone === "danger"
                  ? "border-danger/25 bg-danger/10 text-danger"
                  : ownerBrief.tone === "warning"
                    ? "border-warning/25 bg-warning/10 text-warning"
                    : "border-success/25 bg-success/10 text-success"
              }`}>
                {ownerBrief.label}
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">{ownerBrief.summary}</p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col lg:items-end">
            {ownerBrief.primaryAction ? (
              <Link
                href={ownerBrief.primaryAction.href}
                prefetch={crmLinkPrefetch(ownerBrief.primaryAction.href)}
                className="group inline-flex items-center justify-center gap-2 rounded-[6px] border border-accent/30 bg-accent px-3 py-2 text-sm font-medium text-accent-contrast shadow-lg shadow-black/10 transition-[background-color,border-color,box-shadow,transform] duration-[220ms] ease-out hover:-translate-y-0.5 hover:bg-accent-hover hover:shadow-xl hover:shadow-black/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent motion-reduce:transition-none"
              >
                <span>{ownerBrief.primaryAction.title}</span>
                <ArrowRight className="h-4 w-4 transition-transform duration-[220ms] ease-out group-hover:translate-x-0.5 motion-reduce:transition-none" />
              </Link>
            ) : null}
            <Link
              href="/reports"
              prefetch={false}
              className="inline-flex items-center justify-center gap-2 rounded-[6px] border border-border bg-surface/80 px-3 py-2 text-sm font-medium text-text-secondary transition-[background-color,border-color,color,transform] duration-[220ms] ease-out hover:-translate-y-0.5 hover:border-accent/30 hover:bg-surface-raised hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent motion-reduce:transition-none"
            >
              Open reports
            </Link>
          </div>
        </div>
      </div>
      <div className="grid divide-y divide-border xl:grid-cols-[1.1fr_0.9fr] xl:divide-x xl:divide-y-0">
        <div>
          <OverviewPanelHeader
            title="Today's operating queue"
            description="The next few actions that keep leads warm, classes accurate, students progressing, and tuition clean."
            className="border-b"
          />
          <OverviewActionList
            actions={todayActions}
            emptyTitle="The floor is calm today"
            emptyDescription="No lead follow-ups, attendance checks, promotion approvals, inactivity warnings, or tuition issues are pressing right now."
          />
        </div>
        <div>
          <OverviewPanelHeader
            eyebrow={ownerBrief.setupCopy}
            title="Studio foundation"
            description="Programs, students, ranks, weekly classes, and tuition stay connected."
            className="border-b"
          />
          <SetupStepList steps={setupSteps} />
        </div>
      </div>
    </OverviewPanel>
  );
}

export function DashboardOwnerMetricGrid({
  studentStats,
  leadStats,
  testReadinessStats,
  billingSummary,
  todaySessions,
  canSeeBilling,
  hasDashboardSummary,
  hasPartialStudentSample,
}: {
  studentStats: StudentStats;
  leadStats: LeadStats;
  testReadinessStats: TestReadinessStats;
  billingSummary: BillingSummary;
  todaySessions: number;
  canSeeBilling: boolean;
  hasDashboardSummary: boolean;
  hasPartialStudentSample: boolean;
}) {
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <OverviewMetricCard
        icon={Users}
        label="Students Training"
        value={studentStats.activeStudents}
        helper={
          hasPartialStudentSample && !hasDashboardSummary
            ? `${studentStats.totalStudents} loaded records · open Students for the full roster`
            : `${studentStats.totalStudents} total records · ${studentStats.onHoldStudents} on hold`
        }
        href="/students"
        tone="accent"
        status={
          hasPartialStudentSample && !hasDashboardSummary
            ? "Sample"
            : studentStats.onHoldStudents > 0
              ? "Review holds"
              : "Healthy"
        }
        detail={
          hasPartialStudentSample && hasDashboardSummary
            ? "Totals are exact. Detail lists load from Students."
            : `${studentStats.trialingStudents} trials in the room`
        }
        action="Open roster"
      />
      <OverviewMetricCard
        icon={UserPlus}
        label="Follow-Ups Due"
        value={leadStats.dueTodayLeads}
        helper={`${leadStats.activeLeads} active leads · ${leadStats.enrolledLeads} enrolled`}
        href="/leads"
        tone={leadStats.dueTodayLeads > 0 ? "warning" : "neutral"}
        status={leadStats.dueTodayLeads > 0 ? "Due today" : "Clear"}
        detail={leadStats.dueTodayLeads > 0 ? "Protect the trial pipeline before classes start." : "No urgent follow-up pressure."}
        action="Work leads"
      />
      <OverviewMetricCard
        icon={Calendar}
        label="Classes Today"
        value={todaySessions}
        helper={todaySessions === 0 ? "No classes scheduled today" : `${formatCount(todaySessions, "session")} on deck`}
        href="/schedule"
        tone={todaySessions > 0 ? "info" : "neutral"}
        status={todaySessions > 0 ? "Today" : "Quiet"}
        detail={todaySessions > 0 ? "Attendance drives promotion and retention signals." : "Add recurring classes when the schedule is ready."}
        action="Open schedule"
      />
      <OverviewMetricCard
        icon={Award}
        label="Ready to Promote"
        value={testReadinessStats.readyToTest}
        helper={`${testReadinessStats.needsApproval} waiting on instructor approval`}
        href="/belt-tracker"
        tone={testReadinessStats.readyToTest > 0 ? "success" : "neutral"}
        status={testReadinessStats.readyToTest > 0 ? "Ready" : "Settled"}
        detail={testReadinessStats.readyToTest > 0 ? "Turn earned progress into the next test cycle." : "No promotion queue is waiting."}
        action="Review ranks"
      />
      <OverviewMetricCard
        icon={CreditCard}
        label="Tuition Issues"
        value={canSeeBilling ? billingSummary.paymentAttentionCount ?? "—" : "Hidden"}
        helper={
          canSeeBilling
            ? billingSummary.paymentAttentionCount === null
              ? "Billing queue is unavailable right now"
              : "Failed payments and overdue invoices"
            : "Billing is admin/front desk only"
        }
        href={canSeeBilling ? "/billing" : undefined}
        tone={(billingSummary.paymentAttentionCount ?? 0) > 0 ? "danger" : "neutral"}
        status={
          !canSeeBilling
            ? "Admin only"
            : billingSummary.paymentAttentionCount === null
              ? "Unavailable"
              : billingSummary.paymentAttentionCount > 0
                ? "Needs attention"
                : "Stable"
        }
        detail={
          canSeeBilling
            ? billingSummary.paymentAttentionCount === null
              ? "Refresh or open Billing before making a tuition call."
              : "Keep family payment issues from becoming awkward front-desk surprises."
            : "Ask an admin for tuition status."
        }
        action={canSeeBilling ? "Review billing" : undefined}
      />
    </div>
  );
}

export function DashboardStudentMovementSections({
  inactiveSegments,
  newStudentSegments,
  hasDashboardSummary,
  rosterSummaryPending,
  hasPartialStudentSample,
}: {
  inactiveSegments: MetricSegment[];
  newStudentSegments: MetricSegment[];
  hasDashboardSummary: boolean;
  rosterSummaryPending: boolean;
  hasPartialStudentSample: boolean;
}) {
  return (
    <div className="mb-6 grid gap-3">
      <MetricStripSection
        title="Inactive Students"
        subtitle={
          hasDashboardSummary
            ? "Exact threshold totals from the compact dashboard summary. Current holds are counted separately."
            : rosterSummaryPending
              ? "Exact retention thresholds are hidden until the dashboard summary arrives or the full roster is loaded."
              : sampledDetailText("Active and trialing students whose attendance crossed each threshold", hasPartialStudentSample)
        }
        segments={inactiveSegments}
      />
      <MetricStripSection
        title="New Students"
        subtitle={
          hasDashboardSummary
            ? "Exact active, trialing, or paused student starts from the compact dashboard summary."
            : rosterSummaryPending
              ? "Exact start-date counts are hidden until the dashboard summary arrives or the full roster is loaded."
              : sampledDetailText("Current active, trialing, or paused students with membership starts in each lookback window", hasPartialStudentSample)
        }
        segments={newStudentSegments}
      />
    </div>
  );
}

export function DashboardActivityPanels({
  inactivityStats,
  hasPartialStudentSample,
  rosterSummaryPending,
}: {
  inactivityStats: InactivityStats;
  hasPartialStudentSample: boolean;
  rosterSummaryPending: boolean;
}) {
  return (
    <div className="mb-6 grid gap-px bg-border lg:grid-cols-[1.2fr_0.8fr]">
      <Panel>
        <PanelHeader
          title="Inactivity Watch"
          subtitle={
            rosterSummaryPending
              ? "Exact threshold totals are still loading. Open Students for the full watchlist."
              : hasPartialStudentSample
                ? "Exact threshold totals stay above. Open Students for the full watchlist."
                : "Active and trialing students only. Current holds are excluded automatically."
          }
          href="/reports"
          linkLabel="Open reports"
        />

        {hasPartialStudentSample ? (
          <div className="border border-border bg-surface-raised/40 px-4 py-5 text-sm text-text-secondary">
            Open the Students page to load the complete roster before calling individual inactivity watchlist rows.
          </div>
        ) : inactivityStats.highestRiskStudents.length === 0 ? (
          <div className="border border-border bg-surface-raised/40 px-4 py-5 text-sm text-text-secondary">
            No active students have crossed the 14-day inactivity threshold right now.
          </div>
        ) : (
          <div className="space-y-1">
            {inactivityStats.highestRiskStudents.map((row) => (
              <Link
                key={row.student.id}
                href={`/students/${row.student.id}`}
                className="group relative flex items-center justify-between gap-4 border border-border bg-surface-raised/40 px-4 py-3 transition-colors hover:border-[color:var(--accent)]/30"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    {row.student.preferred_name || row.student.legal_first_name} {row.student.legal_last_name}
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">
                    {row.lastAttendanceDate
                      ? `Last attended ${formatDate(row.lastAttendanceDate)}`
                      : `No attendance yet · member since ${formatDate(row.referenceDate)}`}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-lg font-semibold text-text-primary">{row.daysInactive}</p>
                  <p className="text-[10px] uppercase tracking-widest text-muted">days</p>
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
              prefetch={crmLinkPrefetch(action.href)}
              className="group relative flex items-center gap-2.5 border border-border bg-surface-raised/60 px-4 py-3 text-sm text-text-secondary transition-colors hover:border-[color:var(--accent)]/30 hover:text-text-primary"
            >
              <action.icon className="h-3.5 w-3.5 text-muted transition-colors group-hover:text-accent" />
              {action.label}
            </Link>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export function DashboardProgramBucketsPanel({
  programBuckets,
  programById,
  hasPartialStudentSample,
}: {
  programBuckets: DashboardProgramBucket[];
  programById: Map<string, Program>;
  hasPartialStudentSample: boolean;
}) {
  return (
    <Panel className="mb-6">
      <PanelHeader
        title="Program Buckets"
        subtitle={
          hasPartialStudentSample
            ? "Student rows are sampled from the first loaded roster page; leads and classes are complete."
            : "Active students, open leads, and today's classes grouped by program."
        }
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
                  <p className="mt-0.5 text-muted">{hasPartialStudentSample ? "loaded" : "students"}</p>
                </div>
                <div>
                  <p className="font-mono text-base font-semibold text-text-primary">{row.activeLeads}</p>
                  <p className="mt-0.5 text-muted">leads</p>
                </div>
                <div>
                  <p className="font-mono text-base font-semibold text-text-primary">{row.todaySessions}</p>
                  <p className="mt-0.5 text-muted">today</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function DashboardRecentStudentsPanel({
  recentStudentRows,
  hasDashboardSummary,
  hasPartialStudentSample,
}: {
  recentStudentRows: RecentStudentRow[];
  hasDashboardSummary: boolean;
  hasPartialStudentSample: boolean;
}) {
  if (recentStudentRows.length === 0 && !hasPartialStudentSample) {
    return null;
  }

  return (
    <Panel>
      <PanelHeader
        title="Recent Students"
        subtitle={
          hasDashboardSummary
            ? "Latest student records from the compact dashboard summary."
            : hasPartialStudentSample
              ? "Open Students to load the complete roster before using recent-student detail."
              : undefined
        }
        href="/students"
      />
      {recentStudentRows.length === 0 ? (
        <div className="border-t border-border px-4 py-5 text-sm text-text-secondary">
          Recent student rows are hidden while only the bootstrap roster page is loaded.
        </div>
      ) : (
        <div className="divide-y divide-border border-t border-border">
          {recentStudentRows.map((student) => {
            const initials = student.displayName
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0])
              .join("")
              .toUpperCase();
            return (
              <Link
                key={student.id}
                href={`/students/${student.id}`}
                className="-mx-5 flex items-center justify-between px-5 py-3 transition-colors hover:bg-surface-raised/40"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center border border-border bg-surface-raised">
                    <span className="text-[10px] font-medium text-text-secondary">
                      {initials || "ST"}
                    </span>
                  </div>
                  <span className="truncate text-sm text-text-primary">
                    {student.displayName}
                  </span>
                </div>
                <span
                  className={`px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
                    student.status === "active"
                      ? "bg-success/10 text-success"
                      : student.status === "trialing"
                        ? "bg-accent/10 text-accent"
                        : student.status === "paused"
                          ? "bg-warning/10 text-warning"
                          : "bg-surface-raised text-muted"
                  }`}
                >
                  {student.status}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
