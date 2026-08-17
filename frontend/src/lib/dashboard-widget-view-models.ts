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
  dashboardSummaryLoaded: boolean;
  datasetLoadError: string | null;
  allDatasetEvidenceReady: boolean;
  canSeeBilling: boolean;
  canSeeLeads: boolean;
  hasDashboardSummary: boolean;
  hasPartialStudentSample: boolean;
  studentsLoaded: boolean;
  studentsLoadError: string | null;
  leadsLoaded: boolean;
  leadsLoadError: string | null;
  scheduleStatus: "idle" | "loading" | "ready" | "error";
  scheduleLoadError: string | null;
  eligibilityReady: boolean;
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
  if (state === "loading") {
    return { provenance: "live", provenanceLabel: "Live source pending" };
  }
  return { provenance: "live", provenanceLabel: "Live studio data" };
}

function model(
  input: Pick<DashboardWidgetViewModelInput, "isPreviewMode">,
  value: Omit<DashboardWidgetViewModel, "provenance" | "provenanceLabel">
): DashboardWidgetViewModel {
  return { ...value, ...provenance(input, value.state) };
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

function hasNamedEmergencyContact(student: Student): boolean {
  return Boolean(student.emergency_contact_name?.trim());
}

export function buildDashboardWidgetViewModels(
  input: DashboardWidgetViewModelInput
): Record<DashboardWidgetId, DashboardWidgetViewModel> {
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
    : !input.dashboardSummaryLoaded
      ? "loading"
      : !liveTodaySchedule.available
      ? "unavailable"
      : classesTotal === 0
        ? "empty"
        : "ready";
  const readyPromotions = input.eligibility.filter((entry) => entry.is_eligible).slice(0, 5);
  const attentionRows: DashboardWidgetRow[] = [];
  const billingAttentionPending = input.canSeeBilling && !input.dashboardSummaryLoaded;
  const leadAttentionPending = input.canSeeLeads && !input.leadsLoaded && !input.leadsLoadError;
  const inactivityAttentionPending = !input.hasDashboardSummary && (
    (!input.studentsLoaded && !input.studentsLoadError)
    || ((input.scheduleStatus === "idle" || input.scheduleStatus === "loading") && !input.scheduleLoadError)
  );
  const billingAttentionFailed = input.canSeeBilling
    && input.dashboardSummaryLoaded
    && displayedBillingSummary.paymentAttentionCount === null;
  const leadAttentionFailed = input.canSeeLeads && Boolean(input.leadsLoadError);
  const inactivityAttentionFailed = !input.hasDashboardSummary && Boolean(
    input.studentsLoadError || input.scheduleLoadError
  );
  const inactivityAttentionPartial = !input.hasDashboardSummary
    && input.studentsLoaded
    && input.hasPartialStudentSample;
  const inactivityAttentionSettled = !inactivityAttentionPending
    && !inactivityAttentionFailed
    && !inactivityAttentionPartial;

  if (
    input.canSeeBilling
    && !billingAttentionPending
    && !billingAttentionFailed
    && displayedBillingSummary.paymentAttentionCount
    && displayedBillingSummary.paymentAttentionCount > 0
  ) {
    attentionRows.push({
      label: `${displayedBillingSummary.paymentAttentionCount} billing exception${displayedBillingSummary.paymentAttentionCount === 1 ? "" : "s"}`,
      meta: "Review payment status",
      href: "/billing?tab=invoices",
    });
  }
  if (input.canSeeLeads && !leadAttentionPending && !leadAttentionFailed && displayedLeadStats.dueTodayLeads > 0) {
    attentionRows.push({
      label: `${displayedLeadStats.dueTodayLeads} lead follow-up${displayedLeadStats.dueTodayLeads === 1 ? "" : "s"} due`,
      meta: "Oldest first",
      href: "/leads",
    });
  }
  if (inactivityAttentionSettled && !inactivityAttentionFailed && displayedInactivityStats.watch14 > 0) {
    attentionRows.push({
      label: `${displayedInactivityStats.watch14} students inactive 14+ days`,
      meta: "Attendance watch",
      href: "/students?inactiveDays=14",
    });
  }

  const attentionPending = billingAttentionPending || leadAttentionPending || inactivityAttentionPending;
  const attentionFailed = billingAttentionFailed || leadAttentionFailed || inactivityAttentionFailed;
  const attentionIncomplete = attentionFailed || inactivityAttentionPartial;
  const attentionState: DashboardWidgetState = attentionRows.length > 0
    ? attentionPending || attentionIncomplete
      ? "partial"
      : "ready"
    : attentionPending
      ? "loading"
      : inactivityAttentionPartial
        ? "partial"
        : attentionFailed
          ? "error"
          : "empty";
  const studentPulseState: DashboardWidgetState = input.hasDashboardSummary
    ? displayedStudentStats.totalStudents === 0
      ? "empty"
      : "ready"
    : input.studentsLoadError
      ? "error"
      : !input.studentsLoaded
        ? "loading"
        : input.hasPartialStudentSample
          ? "partial"
          : displayedStudentStats.totalStudents === 0
            ? "empty"
            : "ready";
  const attendanceState: DashboardWidgetState = input.hasDashboardSummary
    ? displayedOperationalStats.sessionsTracked === 0
      ? "empty"
      : "ready"
    : input.scheduleLoadError
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
    : !input.eligibilityReady
      ? "loading"
      : readyPromotions.length === 0
        ? "empty"
        : "ready";
  const billingState: DashboardWidgetState = !input.dashboardSummaryLoaded
    ? "loading"
    : displayedBillingSummary.paymentAttentionCount === null
      ? "unavailable"
    : displayedBillingSummary.paymentAttentionCount === 0
      ? "empty"
      : "ready";
  const recentState: DashboardWidgetState = input.hasDashboardSummary
    ? input.recentStudentRows.length === 0
      ? "empty"
      : "ready"
    : input.studentsLoadError
      ? "error"
      : !input.studentsLoaded
        ? "loading"
        : input.hasPartialStudentSample
          ? "partial"
          : input.recentStudentRows.length === 0
            ? "empty"
            : "ready";
  const activeStudents = input.students.filter((student) => (
    student.status === "active" || student.status === "trialing"
  ));
  const studentsMissingEmergencyContactName = activeStudents.filter((student) => !hasNamedEmergencyContact(student)).length;
  const liveEmergencyContacts = summaryEnrichments.emergencyContacts;
  const emergencyState: DashboardWidgetState = input.isPreviewMode
    ? input.studentsLoadError
      ? "error"
      : !input.studentsLoaded
        ? "loading"
        : studentsMissingEmergencyContactName === 0
          ? "empty"
          : "ready"
    : !input.dashboardSummaryLoaded
      ? "loading"
      : !liveEmergencyContacts.available
      ? "unavailable"
      : liveEmergencyContacts.studentsMissingContactName === 0
        ? "empty"
        : "ready";
  const setupState: DashboardWidgetState = input.datasetLoadError
    ? "error"
    : !input.allDatasetEvidenceReady
      ? "loading"
      : setupSteps.every((step) => step.complete)
        ? "empty"
        : "ready";

  const models: DashboardWidgetViewModel[] = [
    model(input, {
      id: "needs_attention",
      state: attentionState,
      metric: attentionState === "ready" && attentionRows.length > 0
        ? String(attentionRows.length)
        : undefined,
      detail: attentionState === "partial"
        ? "Known obligations are listed while other sources finish or recover."
        : attentionState === "loading"
          ? "Checking each source for current obligations."
          : attentionState === "error"
            ? "Obligations could not be verified from the available sources."
        : attentionState === "empty"
          ? "No known obligations need action right now."
          : "Open obligations across the current studio summary.",
      rows: attentionRows.slice(0, 5),
      actions: [],
    }),
    model(input, {
      id: "classes_today",
      state: classesState,
      metric: classesState === "ready" || classesState === "empty" ? String(classesTotal) : undefined,
      detail: classesState === "loading"
        ? "Today’s bounded class schedule is still loading."
        : classesState === "error"
          ? "Today’s class schedule could not be loaded."
          : classesState === "unavailable"
            ? "Today’s class details are not available from this summary."
            : `${classesTotal} scheduled session${classesTotal === 1 ? "" : "s"} in studio time.`,
      rows: classesState === "ready" ? classRows : [],
      actions: [],
      overflowCount: input.isPreviewMode ? 0 : liveTodaySchedule.overflowCount,
    }),
    model(input, {
      id: "student_pulse",
      state: studentPulseState,
      metric: studentPulseState === "ready" || studentPulseState === "empty"
        ? String(displayedStudentStats.activeStudents)
        : undefined,
      detail: studentPulseState === "loading"
        ? "Waiting for an exact summary or a complete roster."
        : studentPulseState === "error"
          ? "Student totals could not be loaded."
          : studentPulseState === "partial"
            ? "Exact active-student totals require the full roster summary."
            : `${displayedStudentStats.trialingStudents} trialing · ${displayedStudentStats.onHoldStudents} on hold`,
      rows: [],
      actions: [],
      visual: studentPulseState === "ready" || studentPulseState === "empty" ? {
        kind: "ratio",
        value: displayedStudentStats.activeStudents,
        max: displayedStudentStats.totalStudents,
        label: "active students",
      } : undefined,
    }),
    model(input, {
      id: "attendance",
      state: attendanceState,
      metric: attendanceState !== "ready" && attendanceState !== "empty"
        ? undefined
        : displayedOperationalStats.utilizationRate === null
        ? "—"
        : `${Math.round(displayedOperationalStats.utilizationRate * 100)}%`,
      detail: attendanceState === "loading"
        ? "The attendance register is still loading."
        : attendanceState === "error"
          ? "The attendance register could not be loaded."
          : displayedOperationalStats.sessionsTracked > 0
            ? `${displayedOperationalStats.sessionsTracked} sessions tracked over 30 days.`
            : "No completed attendance window is available.",
      rows: [],
      actions: [],
      visual: attendanceState === "ready" && displayedOperationalStats.utilizationRate !== null ? {
        kind: "ratio",
        value: displayedOperationalStats.attendanceWithCapacity,
        max: displayedOperationalStats.totalCapacity,
        label: "seats filled",
      } : undefined,
    }),
    model(input, {
      id: "lead_follow_ups",
      state: leadsState,
      metric: leadsState === "ready" || leadsState === "empty"
        ? String(displayedLeadStats.dueTodayLeads)
        : undefined,
      detail: leadsState === "loading"
        ? "Lead follow-ups are still loading."
        : leadsState === "error"
          ? "Lead follow-ups could not be loaded."
          : leadsState === "empty"
            ? "No follow-ups are due through today."
            : "Open follow-ups due through today.",
      rows: leadsState === "ready" ? dueLeads.map((lead) => ({
        label: `${lead.first_name} ${lead.last_name}`.trim(),
        meta: lead.follow_up_date ?? "Due",
        href: "/leads",
      })) : [],
      actions: [],
    }),
    model(input, {
      id: "promotions_due",
      state: promotionsState,
      metric: promotionsState === "ready" || promotionsState === "empty"
        ? String(displayedTestReadinessStats.readyToTest)
        : undefined,
      detail: promotionsState === "loading"
        ? "Promotion eligibility is still loading."
        : promotionsState === "error"
          ? "Promotion eligibility could not be loaded."
          : `${displayedTestReadinessStats.needsApproval} awaiting approval.`,
      rows: promotionsState === "ready" ? readyPromotions.map((entry) => ({
        label: entry.student_name,
        meta: entry.next_rank_name ? `Ready for ${entry.next_rank_name}` : "Eligible",
        href: "/belt-tracker",
      })) : [],
      actions: [],
    }),
    model(input, {
      id: "billing_exceptions",
      state: billingState,
      metric: billingState === "ready" || billingState === "empty"
        ? String(displayedBillingSummary.paymentAttentionCount)
        : undefined,
      detail: billingState === "loading"
        ? "The billing-safe exception count is still loading."
        : billingState === "unavailable"
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
      detail: "An exact due amount is not present in the current dashboard summary.",
      rows: [],
      actions: [],
    }),
    model(input, {
      id: "setup_progress",
      state: setupState,
      metric: setupState === "ready" || setupState === "empty"
        ? `${setupSteps.filter((step) => step.complete).length}/${setupSteps.length}`
        : undefined,
      detail: setupState === "loading"
        ? "Setup evidence is still loading."
        : setupState === "error"
          ? "Setup progress could not be verified."
          : setupState === "empty"
            ? "Core studio setup is complete."
            : "Finish the remaining studio setup steps.",
      rows: setupState === "ready" ? setupSteps.filter((step) => !step.complete).slice(0, 4).map((step) => ({
        label: step.title,
        href: step.href,
      })) : [],
      actions: [],
      visual: setupState === "ready" || setupState === "empty" ? {
        kind: "ratio",
        value: setupSteps.filter((step) => step.complete).length,
        max: setupSteps.length,
        label: "steps complete",
      } : undefined,
    }),
    model(input, {
      id: "recent_students",
      state: recentState,
      detail: recentState === "loading"
        ? "Waiting for an exact summary or a complete roster."
        : recentState === "error"
          ? "Recent students could not be loaded."
          : recentState === "partial"
            ? "Recent students are hidden because the roster sample is partial."
            : "Recently added student records.",
      rows: recentState === "ready" ? input.recentStudentRows.map((student) => ({
        label: student.displayName,
        meta: student.status,
        href: `/students/${student.id}`,
      })) : [],
      actions: [],
    }),
    model(input, {
      id: "saved_report",
      state: "unavailable",
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
      metric: emergencyState === "ready" || emergencyState === "empty"
        ? String(input.isPreviewMode ? studentsMissingEmergencyContactName : liveEmergencyContacts.studentsMissingContactName)
        : undefined,
      detail: emergencyState === "loading"
        ? "The exact emergency-contact count is still loading."
        : emergencyState === "error"
          ? "Emergency contacts could not be loaded."
          : emergencyState === "unavailable"
            ? "An exact emergency-contact-name count is not available from this summary."
            : emergencyState === "empty"
              ? "Every active student has a named emergency contact."
              : "Active students are missing a named emergency contact.",
      rows: [],
      actions: [],
    }),
  ];

  return Object.fromEntries(models.map((entry) => [entry.id, entry])) as Record<
    DashboardWidgetId,
    DashboardWidgetViewModel
  >;
}
