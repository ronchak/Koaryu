"use client";

import {
  Award,
  BarChart3,
  TrendingDown,
  UserMinus,
} from "lucide-react";

import {
  type KpiInsight,
  KpiTile,
  Panel,
  PanelHeader,
} from "@/components/dashboard/dashboard-page-sections";
import type { DashboardKpiBreakdowns } from "@/lib/dashboard-kpi-breakdowns";
import {
  formatDate,
  formatPercent,
} from "@/lib/dashboard-page-utils";

type OperationalStats = {
  attendanceWithCapacity: number;
  totalCapacity: number;
  sessionsWithCapacity: number;
  utilizationRate: number | null;
};

type TestReadinessStats = {
  readyToTest: number;
  needsApproval: number;
};

type ChurnStats = {
  inactiveStudents: number;
  canceledStudents: number;
  churnMarkedStudents: number;
  churnRate: number | null;
};

type StudentStats = {
  totalStudents: number;
};

export function DashboardOperationalKpisPanel({
  operationalStats,
  testReadinessStats,
  churnStats,
  studentStats,
  kpiBreakdowns,
  lookback30,
  today,
  rosterSummaryPending,
  shouldShowLocalStudentDetails,
  onOpenInsight,
}: {
  operationalStats: OperationalStats;
  testReadinessStats: TestReadinessStats;
  churnStats: ChurnStats;
  studentStats: StudentStats;
  kpiBreakdowns: DashboardKpiBreakdowns;
  lookback30: string;
  today: string;
  rosterSummaryPending: boolean;
  shouldShowLocalStudentDetails: boolean;
  onOpenInsight: (insight: KpiInsight) => void;
}) {
  const operationalKpis: KpiInsight[] = [
    {
      id: "class-utilization",
      icon: BarChart3,
      label: "Class Utilization",
      value: formatPercent(operationalStats.utilizationRate),
      sub: operationalStats.sessionsWithCapacity > 0
        ? `${operationalStats.attendanceWithCapacity} check-ins / ${operationalStats.totalCapacity} seats`
        : "Add class capacities to unlock utilization",
      accent: "#38BDF8",
      summary: "A fullness check for classes where capacity has been configured.",
      measures: "How much of the available capacity was used across non-canceled classes in the last 30 days.",
      calculation: operationalStats.sessionsWithCapacity > 0
        ? `Koaryu looks at non-canceled sessions from ${formatDate(lookback30)} through ${formatDate(today)} that have a capacity, counts attendance records that are not marked absent, and divides ${operationalStats.attendanceWithCapacity} check-ins by ${operationalStats.totalCapacity} available seats. In the belt breakdown, capacity is counted once for each class where that belt family had attendance, then compared against check-ins from that belt family.`
        : "Koaryu needs class capacity values before it can calculate utilization. Sessions without capacity are left out of this percentage.",
      read: "Good usually means classes are comfortably full without being packed. Very low utilization can mean underfilled classes or too many time slots; very high utilization can mean classes are crowded and may need another session or a larger capacity.",
      breakdownTitle: "Breakdown by belt level",
      breakdownEmpty: shouldShowLocalStudentDetails
        ? "No capacity-tracked attendance is available by belt level yet."
        : "Belt-level breakdowns are hidden until the full roster is opened.",
      breakdownSections: shouldShowLocalStudentDetails ? kpiBreakdowns.classUtilization : [],
    },
    {
      id: "students-ready-to-test",
      icon: Award,
      label: "Students Ready to Test",
      value: testReadinessStats.readyToTest,
      sub: `${testReadinessStats.needsApproval} awaiting instructor approval`,
      accent: "#22C55E",
      summary: "A belt-progression snapshot showing who can be promoted based on the configured ladder rules.",
      measures: "Student eligibility entries where the next-rank class, time, and approval requirements are satisfied.",
      calculation: "Koaryu counts eligibility rows where the belt engine marks is_eligible as true. The subline separately counts rows where class and time requirements are met, but the next rank still requires manual instructor approval.",
      read: "Good means there are students moving through the curriculum and not getting stuck. Zero can be fine right after a test cycle, but if it stays zero for a long time, check whether belt requirements are too strict or attendance is too low.",
      breakdownTitle: "Breakdown by belt level",
      breakdownEmpty: shouldShowLocalStudentDetails
        ? "No students are currently ready to test by belt level."
        : "Belt-level breakdowns are hidden until the full roster is opened.",
      breakdownSections: shouldShowLocalStudentDetails ? kpiBreakdowns.readyToTest : [],
    },
    {
      id: "churn-watch",
      icon: TrendingDown,
      label: "Churn Watch",
      value: rosterSummaryPending ? "—" : formatPercent(churnStats.churnRate),
      sub: rosterSummaryPending
        ? "Exact roster summary is still loading"
        : `${churnStats.inactiveStudents} inactive · ${churnStats.canceledStudents} canceled`,
      accent: "#F59E0B",
      summary: "A current roster-health signal for students who have moved out of active participation.",
      measures: "The share of all student records currently marked inactive or canceled.",
      calculation: rosterSummaryPending
        ? "Koaryu hides this value while only the bootstrap roster sample is loaded, because a first-page sample can undercount inactive and canceled students. Wait for the compact dashboard summary or open Students to load the full roster."
        : `Koaryu adds ${churnStats.inactiveStudents} inactive students and ${churnStats.canceledStudents} canceled students, then divides that total by ${studentStats.totalStudents} student records. This is a current-status metric, not a date-bounded churn cohort.`,
      read: rosterSummaryPending
        ? "Use the Students page before making a retention call from this metric."
        : "Lower is better. A rising number means more of the roster has drifted out of active participation, so it is worth checking missed classes, payment issues, and recent cancellations.",
      breakdownTitle: "Breakdown by belt level",
      breakdownEmpty: shouldShowLocalStudentDetails
        ? "No inactive or canceled students are currently assigned to belt levels."
        : rosterSummaryPending
          ? "Churn breakdowns are hidden while only the bootstrap roster sample is loaded."
          : "Belt-level breakdowns are hidden until the full roster is opened.",
      breakdownSections: shouldShowLocalStudentDetails ? kpiBreakdowns.churnWatch : [],
    },
    {
      id: "cancellations",
      icon: UserMinus,
      label: "Cancellations",
      value: rosterSummaryPending ? "—" : churnStats.canceledStudents,
      sub: rosterSummaryPending
        ? "Exact roster summary is still loading"
        : `${churnStats.churnMarkedStudents} inactive or canceled records`,
      accent: "#EF4444",
      summary: "A count of student records that have been explicitly marked canceled.",
      measures: "Students whose current membership status is canceled.",
      calculation: rosterSummaryPending
        ? "Koaryu hides this value while only the bootstrap roster sample is loaded, because cancellation counts need the complete roster or the compact dashboard summary."
        : "Koaryu scans the roster and counts every student with status set to canceled. The supporting text includes inactive plus canceled records so the cancellation count can be read alongside the broader churn watch.",
      read: rosterSummaryPending
        ? "Open Students or wait for the exact dashboard summary before reading this as a cancellation signal."
        : "Lower is better. A few cancellations are normal, but a growing count means you should look for patterns: program fit, pricing objections, schedule issues, or students who went inactive before canceling.",
      breakdownTitle: "Breakdown by belt level",
      breakdownEmpty: shouldShowLocalStudentDetails
        ? "No canceled student records are currently assigned to belt levels."
        : rosterSummaryPending
          ? "Cancellation breakdowns are hidden while only the bootstrap roster sample is loaded."
          : "Belt-level breakdowns are hidden until the full roster is opened.",
      breakdownSections: shouldShowLocalStudentDetails ? kpiBreakdowns.cancellations : [],
    },
  ];

  return (
    <Panel className="mb-6">
      <PanelHeader
        title="Operational KPIs"
        subtitle="30-day class utilization, test readiness, and current churn markers."
        href="/reports"
        linkLabel="View reports"
      />
      <div className="grid gap-px bg-border md:grid-cols-2 xl:grid-cols-4">
        {operationalKpis.map((insight) => (
          <KpiTile
            key={insight.id}
            insight={insight}
            onOpen={() => onOpenInsight(insight)}
          />
        ))}
      </div>
    </Panel>
  );
}
