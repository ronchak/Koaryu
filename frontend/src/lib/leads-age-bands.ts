import type { Lead } from "@/types";

export type LeadAgeBandId = "overdue-8" | "overdue-3" | "overdue-1" | "today" | "upcoming" | "unscheduled";

export const LEAD_AGE_BANDS: { id: LeadAgeBandId; label: string }[] = [
  { id: "overdue-8", label: "8+ days overdue" },
  { id: "overdue-3", label: "3–7 days overdue" },
  { id: "overdue-1", label: "1–2 days overdue" },
  { id: "today", label: "Due today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "unscheduled", label: "Unscheduled / completed" },
];

function dayDifference(date: string, today: string) {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round(
    (new Date(`${today}T00:00:00`).getTime() - new Date(`${date}T00:00:00`).getTime()) / dayMs
  );
}

function getLeadAgeBand(lead: Lead, today: string): LeadAgeBandId {
  if (!lead.follow_up_date || lead.stage === "enrolled") return "unscheduled";
  const daysOverdue = dayDifference(lead.follow_up_date, today);
  if (daysOverdue >= 8) return "overdue-8";
  if (daysOverdue >= 3) return "overdue-3";
  if (daysOverdue >= 1) return "overdue-1";
  if (daysOverdue === 0) return "today";
  return "upcoming";
}

export function groupLeadsByAgeBand(leads: Lead[], today: string) {
  const bands = new Map<LeadAgeBandId, Lead[]>(LEAD_AGE_BANDS.map(({ id }) => [id, []]));
  for (const lead of leads) bands.get(getLeadAgeBand(lead, today))?.push(lead);
  return bands;
}
