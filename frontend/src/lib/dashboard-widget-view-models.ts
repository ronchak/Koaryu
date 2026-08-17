import type { DashboardPageComposition } from "./dashboard-page-composition";
import type { DashboardWidgetId } from "./dashboard-widget-catalog";
import { readDashboardWidgetSummaryEnrichments } from "./dashboard-widget-summary-adapter.ts";
import type { ClassSession, EligibilityEntry, Lead, Student } from "@/types";

export type DashboardWidgetState =
  | "ready"
  | "loading"
  | "error"
  | "empty"
  | "partial"
  | "unavailable";

export type DashboardWidgetProvenance = "live" | "preview" | "partial" | "unavailable" | "error";

export type DashboardWidgetRow = {
  label: string;
  meta?: string;
  href?: string;
};

export type DashboardWidgetAction = {
  label: string;
  href: string;
};

export type DashboardWidgetVisual = {
  kind: "ratio";
  value: number;
  max: number;
  label: string;
};

export type DashboardWidgetViewModel = {
  id: DashboardWidgetId;
  state: DashboardWidgetState;
  provenance: DashboardWidgetProvenance;
  provenanceLabel: string;
  metric?: string;
  detail: string;
  rows: DashboardWidgetRow[];
  actions: DashboardWidgetAction[];
  overflowCount?: number;
  visual?: DashboardWidgetVisual;
};

export type DashboardWidgetViewModelInput = {
  isPreviewMode: boolean;
  dashboardSummary: unknown;
  isInitialDashboardLoading: boolean;
  datasetLoadError: string | null;
  hasDashboardSummary: boolean;
  hasPartialStudentSample: boolean;
  rosterSummaryPending: boolean;
  studentsLoaded: boolean;
  studentsLoadError: string | null;
  leadsLoaded: boolean;
  leadsLoadError: string | null;
  scheduleStatus: "idle" | "loading" | "ready" | "error";
  scheduleLoadError: string | null;
  eligibilityPending: boolean;
  eligibilityLoadError: string | null;
  today: string;
  students: Student[];
  leads: Lead[];
  sessions: ClassSession[];
  eligibility: EligibilityEntry[];
  recentStudentRows: Array<{
    id: string;
    displayName: string;
    status: string;
    startedOn: string | null;
  }>;
  composition: DashboardPageComposition;
};

function provenance(
  input: Pick<DashboardWidgetViewModelInput, "isPreviewMode">,
  state: DashboardWidgetState
): Pick<DashboardWidgetViewModel, "provenance" | "provenanceLabel"> {
  if (state === "unavailable") {
    return { provenance: "unavailable", provenanceLabel: "Source unavailable" };
  }
  if (state === "error") {
    return { provenance: "error", provenanceLabel: "Source error" };
  }
  if (state === "partial") {
    return { provenance: "partial", provenanceLabel: "Partial live data" };
  }
  if (input.isPreviewMode) {
    return { provenance: "preview", provenanceLabel: "Preview fixture" };
  }
  return { provenance: "live", provenanceLabel: "Live studio data" };
}

function model(
  input: Pick<DashboardWidgetViewModelInput, "isPreviewMode">,
  value: Omit<DashboardWidgetViewModel, "provenance" | "provenanceLabel">
): DashboardWidgetViewModel {
  return { ...value, ...provenance(input, value.state) };
}

function loadingModels(input: DashboardWidgetViewModelInput): DashboardWidgetViewModel[] {
  const ids: DashboardWidgetId[] = [
    "needs_attention",
    "classes_today",
    "student_pulse",
    "attendance",
    "lead_follow_ups",
    "promotions_due",
    "billing_exceptions",
    "revenue_due",
    "setup_progress",
    "recent_students",
    "saved_report",
    "quick_actions",
    "emergency_contacts",
  ];
  return ids.map((id) => model(input, {
    id,
    state: "loading",
    detail: "Waiting for the studio summary.",
    rows: [],
    actions: [],
  }));
}

function sessionTime(value: string): string {
  const [hourPart = "0", minute = "00"] = value.split(":");
  const hour = Number(hourPart);
  if (!Number.isFinite(hour)) {
    return value;
  }
  const suffix = hour >= 12 ? "pm" : "am";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute}${suffix}`;
}

function hasCompleteEmergencyContact(student: Student): boolean {
  if (student.emergency_contact_name?.trim() && student.emergency_contact_phone?.trim()) {
    return true;
  }
  return student.guardians.some((guardian) => Boolean(
    guardian.first_name?.trim() && guardian.last_name?.trim() && guardian.phone?.trim()
  ));
}

export function buildDashboardWidgetViewModels(
  input: DashboardWidgetViewModelInput
): Record<DashboardWidgetId, DashboardWidgetViewModel> {
  if (input.isInitialDashboardLoading) {
    return Object.fromEntries(
      loadingModels(input).map((entry) => [entry.id, entry])
    ) as Record<DashboardWidgetId, DashboardWidgetViewModel>;
  }

  const {
    displayedBillingSummary,
    displayedInactivityStats,
    displayedLeadStats,
    displayedOperationalStats,
    displayedStudentStats,
    displayedTestReadinessStats,
    displayedTodaySessions,
    setupSteps,
  } = input.composition;
  const summaryEnrichments = readDashboardWidgetSummaryEnrichments(input.dashboardSummary);

  const dueLeads = input.leads
    .filter((lead) => (
      lead.stage !== "enrolled"
      && lead.stage !== "closed_lost"
      && Boolean(lead.follow_up_date)
      && (lead.follow_up_date ?? "") <= input.today
    ))
    .slice(0, 5);
  const previewTodaySessions = input.sessions
    .filter((session) => session.date === input.today && session.status !== "canceled")
    .sort((left, right) => left.start_time.localeCompare(right.start_time))
    .slice(0, 5);
  const liveTodaySchedule = summaryEnrichments.todaySchedule;
  const classRows: DashboardWidgetRow[] = input.isPreviewMode
    ? previewTodaySessions.map((session) => ({
      label: session.name,
      meta: `${sessionTime(session.start_time)} · ${session.attendance_count}${session.capacity ? ` / ${session.capacity}` : ""} checked in`,
      href: "/schedule",
    }))
    : liveTodaySchedule.rows.map((session) => {
      const countCopy = liveTodaySchedule.expectedCountsAvailable && session.expectedCount !== null
        ? `${session.expectedCount} expected`
        : `${session.attendanceCount} checked in`;
      const capacityCopy = session.capacity === null ? "" : ` · ${session.capacity} capacity`;
      return {
        label: session.name,
        meta: `${sessionTime(session.startTime)} · ${countCopy}${capacityCopy}`,
        href: "/schedule",
      };
    });
  const classesTotal = input.isPreviewMode
    ? displayedTodaySessions
    : liveTodaySchedule.rows.length + liveTodaySchedule.overflowCount;
  const classesState: DashboardWidgetState = input.isPreviewMode
    ? input.scheduleLoadError
      ? "error"
      : input.scheduleStatus === "loading" || input.scheduleStatus === "idle"
        ? "loading"
        : displayedTodaySessions === 0
          ? "empty"
          : "ready"
    : !liveTodaySchedule.available
      ? "unavailable"
      : classesTotal === 0
        ? "empty"
        : "ready";
  const readyPromotions = input.eligibility.filter((entry) => entry.is_eligible).slice(0, 5);
  const attentionRows: DashboardWidgetRow[] = [];
  if (displayedBillingSummary.paymentAttentionCount && displayedBillingSummary.paymentAttentionCount > 0) {
    attentionRows.push({
      label: `${displayedBillingSummary.paymentAttentionCount} billing exception${displayedBillingSummary.paymentAttentionCount === 1 ? "" : "s"}`,
      meta: "Review payment status",
      href: "/billing?tab=invoices",
    });
  }
  if (displayedLeadStats.dueTodayLeads > 0) {
    attentionRows.push({
      label: `${displayedLeadStats.dueTodayLeads} lead follow-up${displayedLeadStats.dueTodayLeads === 1 ? "" : "s"} due`,
      meta: "Oldest first",
      href: "/leads",
    });
  }
  if (!input.rosterSummaryPending && displayedInactivityStats.watch14 > 0) {
    attentionRows.push({
      label: `${displayedInactivityStats.watch14} students inactive 14+ days`,
      meta: "Attendance watch",
      href: "/students?inactiveDays=14",
    });
  }

  const attentionState: DashboardWidgetState = input.datasetLoadError
    ? "partial"
    : attentionRows.length > 0
      ? "ready"
      : "empty";
  const studentPulseState: DashboardWidgetState = input.studentsLoadError
    ? "error"
    : input.rosterSummaryPending
      ? "partial"
      : displayedStudentStats.totalStudents === 0
        ? "empty"
        : "ready";
  const attendanceState: DashboardWidgetState = input.scheduleLoadError
    ? "error"
    : input.scheduleStatus === "loading" || input.scheduleStatus === "idle"
      ? "loading"
      : displayedOperationalStats.sessionsTracked === 0
        ? "empty"
        : "ready";
  const leadsState: DashboardWidgetState = input.leadsLoadError
    ? "error"
    : !input.leadsLoaded
      ? "loading"
      : dueLeads.length === 0
        ? "empty"
        : "ready";
  const promotionsState: DashboardWidgetState = input.eligibilityLoadError
    ? "error"
    : input.eligibilityPending
      ? "loading"
      : readyPromotions.length === 0
        ? "empty"
        : "ready";
  const billingState: DashboardWidgetState = displayedBillingSummary.paymentAttentionCount === null
    ? "unavailable"
    : displayedBillingSummary.paymentAttentionCount === 0
      ? "empty"
      : "ready";
  const recentState: DashboardWidgetState = input.studentsLoadError
    ? "error"
    : input.hasPartialStudentSample && !input.hasDashboardSummary
      ? "partial"
      : input.recentStudentRows.length === 0
        ? "empty"
        : "ready";
  const activeStudents = input.students.filter((student) => (
    student.status === "active" || student.status === "trialing"
  ));
  const missingEmergencyContacts = activeStudents.filter((student) => !hasCompleteEmergencyContact(student)).length;
  const liveEmergencyContacts = summaryEnrichments.emergencyContacts;
  const emergencyState: DashboardWidgetState = input.isPreviewMode
    ? input.studentsLoadError
      ? "error"
      : !input.studentsLoaded
        ? "loading"
        : missingEmergencyContacts === 0
          ? "empty"
          : "ready"
    : !liveEmergencyContacts.available
      ? "unavailable"
      : liveEmergencyContacts.missingStudents === 0
        ? "empty"
        : "ready";

  const models: DashboardWidgetViewModel[] = [
    model(input, {
      id: "needs_attention",
      state: attentionState,
      metric: attentionRows.length > 0 ? String(attentionRows.length) : undefined,
      detail: attentionState === "partial"
        ? "Some sources failed. Available obligations remain listed."
        : attentionState === "empty"
          ? "No known obligations need action right now."
          : "Open obligations across the current studio summary.",
      rows: attentionRows.slice(0, 5),
      actions: [],
    }),
    model(input, {
      id: "classes_today",
      state: classesState,
      metric: classesState === "unavailable" ? "—" : String(classesTotal),
      detail: classesState === "unavailable"
        ? "Today’s class details are not available from this summary."
        : `${classesTotal} scheduled session${classesTotal === 1 ? "" : "s"} in studio time.`,
      rows: classRows,
      actions: [],
      overflowCount: input.isPreviewMode ? 0 : liveTodaySchedule.overflowCount,
    }),
    model(input, {
      id: "student_pulse",
      state: studentPulseState,
      metric: studentPulseState === "partial" ? "—" : String(displayedStudentStats.activeStudents),
      detail: studentPulseState === "partial"
        ? "Exact active-student totals require the full roster summary."
        : `${displayedStudentStats.trialingStudents} trialing · ${displayedStudentStats.onHoldStudents} on hold`,
      rows: [],
      actions: [],
      visual: studentPulseState === "partial" ? undefined : {
        kind: "ratio",
        value: displayedStudentStats.activeStudents,
        max: displayedStudentStats.totalStudents,
        label: "active students",
      },
    }),
    model(input, {
      id: "attendance",
      state: attendanceState,
      metric: displayedOperationalStats.utilizationRate === null
        ? "—"
        : `${Math.round(displayedOperationalStats.utilizationRate * 100)}%`,
      detail: displayedOperationalStats.sessionsTracked > 0
        ? `${displayedOperationalStats.sessionsTracked} sessions tracked over 30 days.`
        : "No completed attendance window is available.",
      rows: [],
      actions: [],
      visual: displayedOperationalStats.utilizationRate === null ? undefined : {
        kind: "ratio",
        value: displayedOperationalStats.attendanceWithCapacity,
        max: displayedOperationalStats.totalCapacity,
        label: "seats filled",
      },
    }),
    model(input, {
      id: "lead_follow_ups",
      state: leadsState,
      metric: String(displayedLeadStats.dueTodayLeads),
      detail: leadsState === "empty" ? "No follow-ups are due through today." : "Open follow-ups due through today.",
      rows: dueLeads.map((lead) => ({
        label: `${lead.first_name} ${lead.last_name}`.trim(),
        meta: lead.follow_up_date ?? "Due",
        href: "/leads",
      })),
      actions: [],
    }),
    model(input, {
      id: "promotions_due",
      state: promotionsState,
      metric: String(displayedTestReadinessStats.readyToTest),
      detail: `${displayedTestReadinessStats.needsApproval} awaiting approval.`,
      rows: readyPromotions.map((entry) => ({
        label: entry.student_name,
        meta: entry.next_rank_name ? `Ready for ${entry.next_rank_name}` : "Eligible",
        href: "/belt-tracker",
      })),
      actions: [],
    }),
    model(input, {
      id: "billing_exceptions",
      state: billingState,
      metric: displayedBillingSummary.paymentAttentionCount === null
        ? "—"
        : String(displayedBillingSummary.paymentAttentionCount),
      detail: billingState === "unavailable"
        ? "The current summary does not expose a billing-safe exception count."
        : billingState === "empty"
          ? "No payment exceptions need attention."
          : "Payment records need review in Billing.",
      rows: [],
      actions: [],
    }),
    model(input, {
      id: "revenue_due",
      state: "unavailable",
      metric: "—",
      detail: "An exact due amount is not present in the current dashboard summary.",
      rows: [],
      actions: [],
    }),
    model(input, {
      id: "setup_progress",
      state: setupSteps.every((step) => step.complete) ? "empty" : "ready",
      metric: `${setupSteps.filter((step) => step.complete).length}/${setupSteps.length}`,
      detail: setupSteps.every((step) => step.complete)
        ? "Core studio setup is complete."
        : "Finish the remaining studio setup steps.",
      rows: setupSteps.filter((step) => !step.complete).slice(0, 4).map((step) => ({
        label: step.title,
        href: step.href,
      })),
      actions: [],
      visual: {
        kind: "ratio",
        value: setupSteps.filter((step) => step.complete).length,
        max: setupSteps.length,
        label: "steps complete",
      },
    }),
    model(input, {
      id: "recent_students",
      state: recentState,
      detail: recentState === "partial"
        ? "Recent students are hidden because the roster sample is partial."
        : "Recently added student records.",
      rows: recentState === "partial" ? [] : input.recentStudentRows.map((student) => ({
        label: student.displayName,
        meta: student.status,
        href: `/students/${student.id}`,
      })),
      actions: [],
    }),
    model(input, {
      id: "saved_report",
      state: "unavailable",
      metric: "—",
      detail: "No saved-report selection is available in the current Dashboard contract.",
      rows: [],
      actions: [],
    }),
    model(input, {
      id: "quick_actions",
      state: "ready",
      detail: "Open a source-owned workflow.",
      rows: [],
      actions: [
        { label: "Add student", href: "/students" },
        { label: "Import CSV", href: "/students/import" },
        { label: "Open leads", href: "/leads" },
        { label: "Take attendance", href: "/schedule" },
      ],
    }),
    model(input, {
      id: "emergency_contacts",
      state: emergencyState,
      metric: emergencyState === "unavailable"
        ? "—"
        : String(input.isPreviewMode ? missingEmergencyContacts : liveEmergencyContacts.missingStudents),
      detail: emergencyState === "unavailable"
        ? "An exact contact-completeness count is not available from this summary."
        : emergencyState === "empty"
          ? "Every active student has a complete emergency contact."
          : "Active students are missing a complete emergency contact.",
      rows: [],
      actions: [],
    }),
  ];

  return Object.fromEntries(models.map((entry) => [entry.id, entry])) as Record<
    DashboardWidgetId,
    DashboardWidgetViewModel
  >;
}
