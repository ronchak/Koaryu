import type { Lead } from "@/types";

export type LeadAgeBandId = "overdue" | "today" | "upcoming" | "unscheduled";

/*
 * Four bands in follow-up order. Overdue is one band: the ledger is already sorted
 * oldest first and every row says how late it is. Leads with no follow-up date and
 * enrolled leads have nothing due.
 */
export const LEAD_AGE_BANDS: { id: LeadAgeBandId; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Due today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "unscheduled", label: "Nothing due" },
];

function getLeadAgeBand(lead: Lead, today: string): LeadAgeBandId {
  if (!lead.follow_up_date || lead.stage === "enrolled") return "unscheduled";
  if (lead.follow_up_date < today) return "overdue";
  if (lead.follow_up_date === today) return "today";
  return "upcoming";
}

export function groupLeadsByAgeBand(leads: Lead[], today: string) {
  const bands = new Map<LeadAgeBandId, Lead[]>(LEAD_AGE_BANDS.map(({ id }) => [id, []]));
  for (const lead of leads) bands.get(getLeadAgeBand(lead, today))?.push(lead);
  return bands;
}
