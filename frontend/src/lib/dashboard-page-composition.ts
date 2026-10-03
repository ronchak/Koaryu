import type { SetupStep } from "@/components/ui/overview";
import {
  isDashboardBillingSetupComplete,
  selectDashboardBillingSummary,
  type DashboardBillingSummary,
} from "./dashboard-billing-summary";
import { isDashboardBeltSetupComplete, isDashboardSetupStepComplete } from "./dashboard-page-model";
import type {
  buildDashboardBeltStats,
  buildDashboardLeadStats,
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
type DashboardOperationalStats = ReturnType<typeof buildDashboardOperationalStats>;
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
  operationalStats: DashboardOperationalStats;
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
};

export type DashboardPageComposition = {
  displayedStudentStats: DashboardStudentStats;
  displayedLeadStats: DashboardLeadStats;
  displayedTodaySessions: DashboardTodaySessions;
  displayedBeltStats: DashboardBeltStats;
  displayedInactivityStats: DashboardInactivityStats;
  displayedOperationalStats: DashboardOperationalStats;
  displayedTestReadinessStats: DashboardTestReadinessStats;
  displayedBillingSummary: DashboardBillingSummary;
  setupSteps: SetupStep[];
};

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
}: DashboardPageCompositionInput): DashboardPageComposition {
  const displayStats = selectDashboardDisplayStats({
    isPreviewMode,
    localStats,
    rosterSummaryPending,
    shouldShowLocalStudentDetails,
    summary,
  });
  const setupSteps = buildDashboardSetupSteps({
    beltStats: displayStats.displayedBeltStats,
    billingSummary: displayStats.displayedBillingSummary,
    canSeeBilling,
    localBeltCount: localStats.beltStats.beltCount,
    programs,
    sessionCount,
    studentCount,
    summary,
    templateCount,
  });
  return {
    ...displayStats,
    setupSteps,
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
    displayedOperationalStats,
    displayedTestReadinessStats,
    displayedBillingSummary,
  };
}

function buildDashboardSetupSteps({
  beltStats,
  billingSummary,
  canSeeBilling,
  localBeltCount,
  programs,
  sessionCount,
  studentCount,
  summary,
  templateCount,
}: {
  beltStats: DashboardBeltStats;
  billingSummary: DashboardBillingSummary;
  canSeeBilling: boolean;
  localBeltCount: number;
  programs: Program[];
  sessionCount: number;
  studentCount: number;
  summary: DashboardSummary | null;
  templateCount: number;
}): SetupStep[] {
  const hasPrograms = isDashboardSetupStepComplete(
    summary?.setup.has_programs,
    programs.some((program) => !program.archived_at),
  );
  const hasStudents = isDashboardSetupStepComplete(summary?.setup.has_students, studentCount > 0);
  const hasBeltSystem = isDashboardBeltSetupComplete(
    summary?.setup.has_belt_system,
    beltStats.beltCount,
    localBeltCount,
  );
  const hasSchedule = isDashboardSetupStepComplete(
    summary?.setup.has_weekly_classes,
    templateCount > 0 || sessionCount > 0,
  );
  const steps: SetupStep[] = [
    {
      id: "programs",
      title: "Name your programs",
      description:
        "Create the training tracks families recognize: Kids, Adults, No-Gi, Tae Kwon Do, and more.",
      complete: hasPrograms,
      href: "/settings",
      actionLabel: "Create programs",
    },
    {
      id: "students",
      title: "Add your students",
      description:
        "Import a roster or add the first few students by hand so Koaryu becomes your live record.",
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
      description:
        "Build the normal class rhythm so attendance and promotion readiness stay current.",
      complete: hasSchedule,
      href: "/schedule",
      actionLabel: "Add classes",
    },
  ];

  if (canSeeBilling) {
    steps.push({
      id: "tuition",
      title: "Review existing billing",
      description:
        "Confirm current plans, family records, invoices, and supported external-payment tracking.",
      complete: isDashboardBillingSetupComplete({ billingSummary, summary }),
      href: "/billing",
      actionLabel: "Review billing",
    });
  }

  return steps;
}
