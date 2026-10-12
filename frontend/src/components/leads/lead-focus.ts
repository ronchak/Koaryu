import { differenceInLocalDateKeys } from "../../lib/date.ts";
import { PIPELINE_STAGES, formatDate } from "../../lib/leads-page-model.ts";
import type { Lead, LeadStage } from "@/types";

/** A quick filter on the follow-up queue, set from the stage strip or a `/leads?focus=` link. */
export type LeadFocus =
  | { kind: "overdue" }
  | { kind: "today" }
  | { kind: "unassigned" }
  | { kind: "stage"; stage: LeadStage };

export type LeadDueTone = "alert" | "warn" | "neutral";

export function isOpenLead(lead: Lead) {
  return lead.stage !== "enrolled" && lead.stage !== "closed_lost";
}

export function matchesLeadFocus(lead: Lead, focus: LeadFocus | null, today: string) {
  if (!focus) return true;
  switch (focus.kind) {
    case "overdue":
      return isOpenLead(lead) && Boolean(lead.follow_up_date && lead.follow_up_date < today);
    case "today":
      return isOpenLead(lead) && lead.follow_up_date === today;
    case "unassigned":
      return isOpenLead(lead) && !lead.assigned_staff_id;
    case "stage":
      return lead.stage === focus.stage;
  }
}

export function describeLeadFocus(focus: LeadFocus) {
  switch (focus.kind) {
    case "overdue":
      return "overdue follow-ups";
    case "today":
      return "follow-ups due today";
    case "unassigned":
      return "leads without an owner";
    case "stage":
      return `${PIPELINE_STAGES.find((stage) => stage.id === focus.stage)?.label ?? "this stage"} leads`;
  }
}

export function isSameLeadFocus(a: LeadFocus | null, b: LeadFocus | null) {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind !== "stage" || (b.kind === "stage" && a.stage === b.stage);
}

/** "3 days overdue", "Due today", "Due tomorrow" or "Due Oct 11", with the tone it deserves. */
export function describeLeadDue(date: string | null | undefined, today: string) {
  if (!date) return { label: "No follow-up date", tone: "neutral" as LeadDueTone };
  if (date === today) return { label: "Due today", tone: "warn" as LeadDueTone };
  if (date < today) {
    const overdueDays = Math.max(1, differenceInLocalDateKeys(date, today));
    return {
      label: `${overdueDays} ${overdueDays === 1 ? "day" : "days"} overdue`,
      tone: "alert" as LeadDueTone,
    };
  }
  if (differenceInLocalDateKeys(today, date) === 1) {
    return { label: "Due tomorrow", tone: "neutral" as LeadDueTone };
  }
  return { label: `Due ${formatDate(date)}`, tone: "neutral" as LeadDueTone };
}

export function getLeadFigures(leads: Lead[], today: string) {
  const open = leads.filter(isOpenLead);
  const overdue = open.filter((lead) => lead.follow_up_date && lead.follow_up_date < today);
  const oldest = overdue.reduce<string | null>(
    (current, lead) =>
      !current || (lead.follow_up_date && lead.follow_up_date < current)
        ? (lead.follow_up_date ?? current)
        : current,
    null,
  );
  return {
    open: open.length,
    overdue: overdue.length,
    oldestOverdueDays: oldest ? differenceInLocalDateKeys(oldest, today) : 0,
    dueToday: open.filter((lead) => lead.follow_up_date === today).length,
    trialsBooked: open.filter((lead) => lead.stage === "trial_scheduled").length,
    unassigned: open.filter((lead) => !lead.assigned_staff_id).length,
  };
}

/** The one thing to do next for a lead, from its stage. */
export function getLeadNextAction(lead: Lead) {
  if (lead.stage === "enrolled") return "Enrollment complete";
  if (!lead.follow_up_date) return "Schedule the next contact";
  switch (lead.stage) {
    case "inquiry":
      return "Make first contact";
    case "trial_scheduled":
      return "Confirm trial attendance";
    case "trial_completed":
      return "Review trial and next step";
    case "offer_sent":
      return "Follow up on the offer";
    case "closed_lost":
      return "Review closed record";
  }
}
