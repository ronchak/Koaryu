import {
  Award,
  Calendar,
  CreditCard,
  TrendingDown,
  UserPlus,
  Users,
} from "lucide-react";

import type { DashboardOwnerBrief } from "@/components/dashboard/dashboard-overview-sections";
import type { MetricSegment } from "@/components/dashboard/dashboard-page-sections";
import type {
  OverviewAction,
  SetupStep,
} from "@/components/ui/overview";
import {
  getDashboardBillingActionKind,
  isDashboardBillingSetupComplete,
  selectDashboardBillingSummary,
  type DashboardBillingSummary,
} from "./dashboard-billing-summary";
import { formatCount } from "./dashboard-page-utils";
import type {
  buildDashboardBeltStats,
  buildDashboardChurnStats,
  buildDashboardLeadStats,
  buildDashboardNewStudentStats,
  buildDashboardOperationalStats,
  buildDashboardStudentStats,
  buildDashboardTestReadinessStats,
  countDashboardTodaySessions,
} from "./dashboard-page-model";
import type { StudentInactivityRow } from "./student-insights";
import type { Program } from "@/types";
import type { DashboardSummary } from "@/types/dashboard";

type DashboardStudentStats = ReturnType<typeof buildDashboardStudentStats>;
type DashboardLeadStats = ReturnType<typeof buildDashboardLeadStats>;
type DashboardTodaySessions = ReturnType<typeof countDashboardTodaySessions>;
type DashboardBeltStats = ReturnType<typeof buildDashboardBeltStats>;
type DashboardNewStudentStats = ReturnType<typeof buildDashboardNewStudentStats>;
type DashboardOperationalStats = ReturnType<typeof buildDashboardOperationalStats>;
type DashboardChurnStats = ReturnType<typeof buildDashboardChurnStats>;
type DashboardTestReadinessStats = ReturnType<typeof buildDashboardTestReadinessStats>;

type DashboardInactivityStats = {
  watch14: number;
  watch30: number;
  watch90: number;
  highestRiskStudents: StudentInactivityRow[];
};

export type DashboardLocalStats = {
  studentStats: DashboardStudentStats;
  leadStats: DashboardLeadStats;
  todaySessions: DashboardTodaySessions;
  beltStats: DashboardBeltStats;
  inactivityStats: DashboardInactivityStats;
  newStudentStats: DashboardNewStudentStats;
  operationalStats: DashboardOperationalStats;
  churnStats: DashboardChurnStats;
  testReadinessStats: DashboardTestReadinessStats;
};

export type DashboardPageCompositionInput = {
  canSeeBilling: boolean;
  isPreviewMode: boolean;
  localStats: DashboardLocalStats;
  programs: Program[];
  rosterSummaryPending: boolean;
  sessionCount: number;
  shouldShowLocalStudentDetails: boolean;
  studentCount: number;
  summary: DashboardSummary | null;
  templateCount: number;
  todayLabel: string;
};

export type DashboardPageComposition = {
  displayedStudentStats: DashboardStudentStats;
  displayedLeadStats: DashboardLeadStats;
  displayedTodaySessions: DashboardTodaySessions;
  displayedBeltStats: DashboardBeltStats;
  displayedInactivityStats: DashboardInactivityStats;
  displayedNewStudentStats: DashboardNewStudentStats;
  displayedOperationalStats: DashboardOperationalStats;
  displayedChurnStats: DashboardChurnStats;
  displayedTestReadinessStats: DashboardTestReadinessStats;
  displayedBillingSummary: DashboardBillingSummary;
  inactiveSegments: MetricSegment[];
  newStudentSegments: MetricSegment[];
  ownerBrief: DashboardOwnerBrief;
  setupSteps: SetupStep[];
  todayActions: OverviewAction[];
};

export function formatDashboardTodayLabel(displayedToday: string) {
  return new Date(`${displayedToday}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function buildDashboardPageComposition({
  canSeeBilling,
  isPreviewMode,
  localStats,
  programs,
  rosterSummaryPending,
  sessionCount,
  shouldShowLocalStudentDetails,
  studentCount,
  summary,
  templateCount,
  todayLabel,
}: DashboardPageCompositionInput): DashboardPageComposition {
  const displayStats = selectDashboardDisplayStats({
    isPreviewMode,
    localStats,
    rosterSummaryPending,
    shouldShowLocalStudentDetails,
    summary,
  });
  const inactiveSegments = buildDashboardInactiveSegments({
    inactivityStats: displayStats.displayedInactivityStats,
    rosterSummaryPending,
    studentStats: displayStats.displayedStudentStats,
  });
  const newStudentSegments = buildDashboardNewStudentSegments({
    newStudentStats: displayStats.displayedNewStudentStats,
    rosterSummaryPending,
  });
  const setupSteps = buildDashboardSetupSteps({
    beltStats: displayStats.displayedBeltStats,
    billingSummary: displayStats.displayedBillingSummary,
    canSeeBilling,
    programs,
    sessionCount,
    studentCount,
    summary,
    templateCount,
  });
  const todayActions = buildDashboardTodayActions({
    beltStats: displayStats.displayedBeltStats,
    billingSummary: displayStats.displayedBillingSummary,
    canSeeBilling,
    inactivityStats: displayStats.displayedInactivityStats,
    leadStats: displayStats.displayedLeadStats,
    rosterSummaryPending,
    sessionCount,
    templateCount,
    testReadinessStats: displayStats.displayedTestReadinessStats,
    todayLabel,
    todaySessions: displayStats.displayedTodaySessions,
  });
  const ownerBrief = buildDashboardOwnerBrief({
    billingSummary: displayStats.displayedBillingSummary,
    canSeeBilling,
    inactivityStats: displayStats.displayedInactivityStats,
    leadStats: displayStats.displayedLeadStats,
    rosterSummaryPending,
    setupSteps,
    testReadinessStats: displayStats.displayedTestReadinessStats,
    todayActions,
    todaySessions: displayStats.displayedTodaySessions,
  });

  return {
    ...displayStats,
    inactiveSegments,
    newStudentSegments,
    ownerBrief,
    setupSteps,
    todayActions,
  };
}

function selectDashboardDisplayStats({
  isPreviewMode,
  localStats,
  rosterSummaryPending,
  shouldShowLocalStudentDetails,
  summary,
}: {
  isPreviewMode: boolean;
  localStats: DashboardLocalStats;
  rosterSummaryPending: boolean;
  shouldShowLocalStudentDetails: boolean;
  summary: DashboardSummary | null;
}) {
  const displayedStudentStats = summary
    ? {
        totalStudents: summary.students.total_students,
        activeStudents: summary.students.active_students,
        trialingStudents: summary.students.trialing_students,
        onHoldStudents: summary.students.on_hold_students,
      }
    : localStats.studentStats;
  const displayedLeadStats = summary
    ? {
        activeLeads: summary.leads.active_leads,
        enrolledLeads: summary.leads.enrolled_leads,
        dueTodayLeads: summary.leads.due_today_leads,
      }
    : localStats.leadStats;
  const displayedTodaySessions = summary?.schedule.today_sessions ?? localStats.todaySessions;
  const displayedBeltStats = summary
    ? {
        beltCount: summary.belts.belt_count,
        tipCount: summary.belts.tip_count,
      }
    : localStats.beltStats;
  const displayedInactivityStats = summary
    ? {
        ...localStats.inactivityStats,
        highestRiskStudents: shouldShowLocalStudentDetails
          ? localStats.inactivityStats.highestRiskStudents
          : [],
        watch14: summary.inactivity.watch_14,
        watch30: summary.inactivity.watch_30,
        watch90: summary.inactivity.watch_90,
      }
    : rosterSummaryPending
      ? {
          watch14: 0,
          watch30: 0,
          watch90: 0,
          highestRiskStudents: [],
        }
      : localStats.inactivityStats;
  const displayedNewStudentStats = summary
    ? {
        new14: summary.new_students.new_14,
        new30: summary.new_students.new_30,
        new90: summary.new_students.new_90,
        newYearToDate: summary.new_students.new_year_to_date,
      }
    : rosterSummaryPending
      ? {
          new14: 0,
          new30: 0,
          new90: 0,
          newYearToDate: 0,
        }
      : localStats.newStudentStats;
  const displayedOperationalStats = summary
    ? {
        attendanceWithCapacity: summary.operational.attendance_with_capacity,
        totalCapacity: summary.operational.total_capacity,
        sessionsTracked: summary.operational.sessions_tracked,
        sessionsWithCapacity: summary.operational.sessions_with_capacity,
        utilizationRate: summary.operational.utilization_rate ?? null,
        averageAttendance: summary.operational.average_attendance,
      }
    : localStats.operationalStats;
  const displayedChurnStats = summary
    ? {
        inactiveStudents: summary.churn.inactive_students,
        canceledStudents: summary.churn.canceled_students,
        churnMarkedStudents: summary.churn.churn_marked_students,
        churnRate: summary.churn.churn_rate ?? null,
      }
    : rosterSummaryPending
      ? {
          inactiveStudents: 0,
          canceledStudents: 0,
          churnMarkedStudents: 0,
          churnRate: null,
        }
      : localStats.churnStats;
  const displayedTestReadinessStats = summary?.test_readiness.available
    ? {
        readyToTest: summary.test_readiness.ready_to_test ?? 0,
        needsApproval: summary.test_readiness.needs_approval ?? 0,
      }
    : localStats.testReadinessStats;
  const displayedBillingSummary = selectDashboardBillingSummary({
    isPreviewMode,
    summary,
  });

  return {
    displayedStudentStats,
    displayedLeadStats,
    displayedTodaySessions,
    displayedBeltStats,
    displayedInactivityStats,
    displayedNewStudentStats,
    displayedOperationalStats,
    displayedChurnStats,
    displayedTestReadinessStats,
    displayedBillingSummary,
  };
}

function buildDashboardInactiveSegments({
  inactivityStats,
  rosterSummaryPending,
  studentStats,
}: {
  inactivityStats: DashboardInactivityStats;
  rosterSummaryPending: boolean;
  studentStats: DashboardStudentStats;
}): MetricSegment[] {
  return [
    {
      label: "14+ inactive",
      value: rosterSummaryPending ? "—" : inactivityStats.watch14,
      color: "#F59E0B",
      href: "/students?inactiveDays=14",
    },
    {
      label: "30+ inactive",
      value: rosterSummaryPending ? "—" : inactivityStats.watch30,
      color: "#EF4444",
      href: "/students?inactiveDays=30",
    },
    {
      label: "90+ inactive",
      value: rosterSummaryPending ? "—" : inactivityStats.watch90,
      color: "#B91C1C",
      href: "/students?inactiveDays=90",
    },
    {
      label: "On hold",
      value: rosterSummaryPending ? "—" : studentStats.onHoldStudents,
      color: "#64748B",
      href: "/students",
    },
  ];
}

function buildDashboardNewStudentSegments({
  newStudentStats,
  rosterSummaryPending,
}: {
  newStudentStats: DashboardNewStudentStats;
  rosterSummaryPending: boolean;
}): MetricSegment[] {
  return [
    {
      label: "Last 14 days",
      value: rosterSummaryPending ? "—" : newStudentStats.new14,
      color: "#38BDF8",
      href: "/students?newStudents=14",
    },
    {
      label: "Last 30 days",
      value: rosterSummaryPending ? "—" : newStudentStats.new30,
      color: "#22C55E",
      href: "/students?newStudents=30",
    },
    {
      label: "Last 90 days",
      value: rosterSummaryPending ? "—" : newStudentStats.new90,
      color: "#8B5CF6",
      href: "/students?newStudents=90",
    },
    {
      label: "Year to date",
      value: rosterSummaryPending ? "—" : newStudentStats.newYearToDate,
      color: "#F59E0B",
      href: "/students?newStudents=ytd",
    },
  ];
}

function buildDashboardSetupSteps({
  beltStats,
  billingSummary,
  canSeeBilling,
  programs,
  sessionCount,
  studentCount,
  summary,
  templateCount,
}: {
  beltStats: DashboardBeltStats;
  billingSummary: DashboardBillingSummary;
  canSeeBilling: boolean;
  programs: Program[];
  sessionCount: number;
  studentCount: number;
  summary: DashboardSummary | null;
  templateCount: number;
}): SetupStep[] {
  const hasPrograms = summary?.setup.has_programs ?? programs.some((program) => !program.archived_at);
  const hasStudents = summary?.setup.has_students ?? studentCount > 0;
  const hasBeltSystem = summary?.setup.has_belt_system ?? beltStats.beltCount > 0;
  const hasSchedule = summary?.setup.has_weekly_classes ?? (templateCount > 0 || sessionCount > 0);
  const steps: SetupStep[] = [
    {
      id: "programs",
      title: "Name your programs",
      description: "Create the training tracks families recognize: Kids, Adults, No-Gi, Tae Kwon Do, and more.",
      complete: hasPrograms,
      href: "/settings",
      actionLabel: "Create programs",
    },
    {
      id: "students",
      title: "Add your students",
      description: "Import a roster or add the first few students by hand so Koaryu becomes your live record.",
      complete: hasStudents,
      href: hasStudents ? "/students" : "/students/import",
      actionLabel: "Import students",
    },
    {
      id: "belt-system",
      title: "Set the belt system",
      description: "Define ranks, stripes, minimum classes, and approval rules for each program.",
      complete: hasBeltSystem,
      href: "/belt-tracker",
      actionLabel: "Set ranks",
    },
    {
      id: "weekly-classes",
      title: "Add weekly classes",
      description: "Build the normal class rhythm so attendance and promotion readiness stay current.",
      complete: hasSchedule,
      href: "/schedule",
      actionLabel: "Add classes",
    },
  ];

  if (canSeeBilling) {
    steps.push({
      id: "tuition",
      title: "Create tuition plans",
      description: "Set up the plans families pay for, then connect Stripe when you are ready to collect through Koaryu.",
      complete: isDashboardBillingSetupComplete({ billingSummary, summary }),
      href: "/billing",
      actionLabel: "Create plans",
    });
  }

  return steps;
}

function buildDashboardTodayActions({
  beltStats,
  billingSummary,
  canSeeBilling,
  inactivityStats,
  leadStats,
  rosterSummaryPending,
  sessionCount,
  templateCount,
  testReadinessStats,
  todayLabel,
  todaySessions,
}: {
  beltStats: DashboardBeltStats;
  billingSummary: DashboardBillingSummary;
  canSeeBilling: boolean;
  inactivityStats: DashboardInactivityStats;
  leadStats: DashboardLeadStats;
  rosterSummaryPending: boolean;
  sessionCount: number;
  templateCount: number;
  testReadinessStats: DashboardTestReadinessStats;
  todayLabel: string;
  todaySessions: DashboardTodaySessions;
}): OverviewAction[] {
  const actions: OverviewAction[] = [];

  if (leadStats.dueTodayLeads > 0) {
    actions.push({
      id: "lead-followups",
      title: `Follow up with ${formatCount(leadStats.dueTodayLeads, "lead")}`,
      description: "These prospects are due today. Handle them before the next class block gets busy.",
      href: "/leads",
      icon: UserPlus,
      tone: "accent",
      meta: "Today",
    });
  } else if (leadStats.activeLeads === 0) {
    actions.push({
      id: "first-lead",
      title: "Add your first lead",
      description: "Track a trial student or parent inquiry so follow-ups do not live in someone's memory.",
      href: "/leads",
      icon: UserPlus,
      tone: "accent",
    });
  }

  if (todaySessions > 0) {
    actions.push({
      id: "today-classes",
      title: `Check in ${formatCount(todaySessions, "class", "classes")}`,
      description: "Open today's schedule, mark attendance, and keep promotion progress accurate.",
      href: "/schedule",
      icon: Calendar,
      tone: "warning",
      meta: todayLabel,
    });
  } else if (templateCount === 0 && sessionCount === 0) {
    actions.push({
      id: "first-class",
      title: "Add weekly classes",
      description: "Build the normal schedule so instructors can run attendance from Koaryu.",
      href: "/schedule",
      icon: Calendar,
      tone: "warning",
    });
  }

  if (testReadinessStats.readyToTest > 0) {
    actions.push({
      id: "ready-to-promote",
      title: `Review ${formatCount(testReadinessStats.readyToTest, "student")} ready to promote`,
      description: "These students meet the configured class, time, and approval rules for their next rank.",
      href: "/belt-tracker",
      icon: Award,
      tone: "success",
      meta: `${testReadinessStats.needsApproval} approvals`,
    });
  } else if (beltStats.beltCount === 0) {
    actions.push({
      id: "belt-system",
      title: "Set up your belt system",
      description: "Add ranks and promotion rules before your first test cycle sneaks up on you.",
      href: "/belt-tracker",
      icon: Award,
      tone: "success",
    });
  }

  if (rosterSummaryPending) {
    actions.push({
      id: "load-full-roster",
      title: "Load full roster details",
      description: "The dashboard is waiting for an exact roster summary before surfacing retention calls.",
      href: "/students?fullRoster=1",
      icon: Users,
      tone: "neutral",
    });
  } else if (inactivityStats.watch14 > 0) {
    actions.push({
      id: "students-going-quiet",
      title: `Reach out to ${formatCount(inactivityStats.watch14, "student")} going quiet`,
      description: "They have crossed 14 days without attendance and are not currently on hold.",
      href: "/students?inactiveDays=14",
      icon: TrendingDown,
      tone: "warning",
    });
  }

  const billingActionKind = getDashboardBillingActionKind({
    billingSummary,
    canSeeBilling,
  });

  if (billingActionKind === "payment-issues") {
    const paymentAttentionCount = billingSummary.paymentAttentionCount ?? 0;
    actions.push({
      id: "payment-issues",
      title: `Fix ${formatCount(paymentAttentionCount, "tuition issue")}`,
      description: "Review failed payments, past-due families, and invoices that need manual attention.",
      href: "/billing",
      icon: CreditCard,
      tone: "danger",
    });
  } else if (billingActionKind === "payments-setup") {
    actions.push({
      id: "payments-setup",
      title: "Finish payment setup",
      description: "Create tuition plans or finish Stripe Connect when you are ready to collect through Koaryu.",
      href: "/billing",
      icon: CreditCard,
      tone: "neutral",
    });
  }

  return actions.slice(0, 5);
}

function buildDashboardOwnerBrief({
  billingSummary,
  canSeeBilling,
  inactivityStats,
  leadStats,
  rosterSummaryPending,
  setupSteps,
  testReadinessStats,
  todayActions,
  todaySessions,
}: {
  billingSummary: DashboardBillingSummary;
  canSeeBilling: boolean;
  inactivityStats: DashboardInactivityStats;
  leadStats: DashboardLeadStats;
  rosterSummaryPending: boolean;
  setupSteps: SetupStep[];
  testReadinessStats: DashboardTestReadinessStats;
  todayActions: OverviewAction[];
  todaySessions: DashboardTodaySessions;
}): DashboardOwnerBrief {
  const setupCompletedCount = setupSteps.filter((step) => step.complete).length;
  const billingUnknown = canSeeBilling && billingSummary.paymentAttentionCount === null;
  const billingIssues = canSeeBilling && billingSummary.paymentAttentionCount !== null
    ? billingSummary.paymentAttentionCount
    : 0;
  const pressureScore =
    (leadStats.dueTodayLeads > 0 ? 2 : 0) +
    Math.min(todaySessions, 3) +
    (testReadinessStats.readyToTest > 0 ? 2 : 0) +
    (!rosterSummaryPending && inactivityStats.watch14 > 0 ? 2 : 0) +
    (billingIssues > 0 ? 2 : 0);
  const tone: DashboardOwnerBrief["tone"] = rosterSummaryPending
    ? "warning"
    : pressureScore >= 7
      ? "danger"
      : pressureScore >= 4
        ? "warning"
        : "success";
  const label = rosterSummaryPending
    ? "Roster summary pending"
    : pressureScore >= 7
      ? "High pressure"
      : pressureScore >= 4
        ? "Focused day"
        : "Clear day";
  const reasons = [
    todaySessions > 0 ? formatCount(todaySessions, "class", "classes") : null,
    leadStats.dueTodayLeads > 0 ? formatCount(leadStats.dueTodayLeads, "lead follow-up") : null,
    testReadinessStats.readyToTest > 0
      ? formatCount(testReadinessStats.readyToTest, "promotion review")
      : null,
    rosterSummaryPending
      ? "retention summary loading"
      : inactivityStats.watch14 > 0
        ? formatCount(inactivityStats.watch14, "retention check")
        : null,
    billingIssues > 0 ? formatCount(billingIssues, "tuition issue") : null,
    billingUnknown ? "billing queue unavailable" : null,
  ].filter((reason): reason is string => Boolean(reason));
  const primaryAction = todayActions[0] ?? null;

  return {
    tone,
    label,
    primaryAction,
    summary: reasons.length > 0
      ? reasons.join(" · ")
      : canSeeBilling
        ? "No urgent follow-ups, attendance checks, promotions, retention alerts, or tuition issues are pressing."
        : "No urgent follow-ups, attendance checks, promotions, or retention alerts are pressing. Billing is admin/front desk only.",
    setupCopy: `${setupCompletedCount} of ${setupSteps.length} setup steps complete`,
  };
}
