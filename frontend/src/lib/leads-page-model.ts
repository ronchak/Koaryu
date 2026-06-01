import type { Lead, LeadSource, LeadStage, Program } from "@/types";

export const PIPELINE_STAGES: { id: LeadStage; label: string; hex: string }[] = [
  { id: "inquiry", label: "Inquiry", hex: "var(--accent)" },
  { id: "trial_scheduled", label: "Trial Scheduled", hex: "var(--warning)" },
  { id: "trial_completed", label: "Trial Completed", hex: "#1E90FF" },
  { id: "offer_sent", label: "Offer Sent", hex: "#8B5CF6" },
  { id: "enrolled", label: "Enrolled", hex: "var(--success)" },
];

export const SOURCE_LABELS: Record<LeadSource, string> = {
  walk_in: "Walk-in",
  referral: "Referral",
  social: "Social",
  search: "Search",
  website: "Website",
  other: "Other",
};

const DAY_MS = 1000 * 60 * 60 * 24;

interface LeadsPageModelInput {
  baseLeads: Lead[];
  draggedLeadId: string | null;
  optimisticLeads: Record<string, Lead>;
  programs: Program[];
  selectedLeadId: string | null;
  today: string;
}

interface LeadsPageModel {
  activePrograms: Program[];
  draggedLeadRecord: Lead | null;
  dueTodayCount: number;
  enrolledCount: number;
  followUpQueue: Lead[];
  leads: Lead[];
  leadsByStage: Partial<Record<LeadStage, Lead[]>>;
  lostLeads: Lead[];
  overdueCount: number;
  programById: Map<string, Program>;
  selectedLead: Lead | null;
  totalActive: number;
  upcomingFollowUps: number;
}

export function formatDate(value?: string | null, withYear = false) {
  if (!value) return "";

  return new Date(`${value}T00:00:00`).toLocaleDateString(
    "en-US",
    withYear
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric" }
  );
}

export function timeAgo(value: string, nowMs = Date.now()) {
  const diff = nowMs - new Date(value).getTime();
  const days = Math.floor(diff / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

export function todayDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function fullName(lead: Pick<Lead, "first_name" | "last_name">) {
  return `${lead.first_name} ${lead.last_name}`;
}

export function getNextStage(stage: LeadStage): LeadStage | null {
  const currentIndex = PIPELINE_STAGES.findIndex((candidate) => candidate.id === stage);
  if (currentIndex === -1 || currentIndex === PIPELINE_STAGES.length - 1) {
    return null;
  }

  return PIPELINE_STAGES[currentIndex + 1].id;
}

export function getStageLabel(stage: LeadStage) {
  if (stage === "closed_lost") {
    return "Closed Lost";
  }
  return PIPELINE_STAGES.find((candidate) => candidate.id === stage)?.label ?? stage;
}

export function getFollowUpStatusLabel(date: string, today: string) {
  if (date === today) {
    return "Due today";
  }

  const diffMs =
    new Date(`${today}T00:00:00`).getTime() -
    new Date(`${date}T00:00:00`).getTime();
  const diffDays = Math.floor(diffMs / DAY_MS);

  if (diffDays > 0) {
    return `${diffDays}d overdue`;
  }

  return `Due ${formatDate(date)}`;
}

export function getProgramLabel(lead: Lead, program?: Program | null) {
  return program?.name || lead.program_interest || "No program";
}

export function mergeOptimisticLeads(
  baseLeads: Lead[],
  optimisticLeads: Record<string, Lead>
) {
  const merged = new Map<string, Lead>();

  baseLeads.forEach((lead) => {
    merged.set(lead.id, lead);
  });

  Object.entries(optimisticLeads).forEach(([leadId, optimisticLead]) => {
    merged.set(leadId, optimisticLead);
  });

  return Array.from(merged.values());
}

export function groupLeadsByStage(leads: Lead[]) {
  const map: Partial<Record<LeadStage, Lead[]>> = {};
  PIPELINE_STAGES.forEach((stage) => {
    map[stage.id] = [];
  });

  leads
    .filter((lead) => lead.stage !== "closed_lost")
    .forEach((lead) => {
      if (map[lead.stage]) {
        map[lead.stage]?.push(lead);
      }
    });

  return map;
}

export function getLostLeads(leads: Lead[]) {
  return leads.filter((lead) => lead.stage === "closed_lost");
}

export function getDueFollowUpQueue(leads: Lead[], today: string) {
  return leads
    .filter(
      (lead) =>
        lead.stage !== "closed_lost" &&
        lead.stage !== "enrolled" &&
        !!lead.follow_up_date &&
        lead.follow_up_date <= today
    )
    .sort((a, b) => (a.follow_up_date ?? "").localeCompare(b.follow_up_date ?? ""));
}

export function getDueTodayCount(followUpQueue: Lead[], today: string) {
  return followUpQueue.filter((lead) => lead.follow_up_date === today).length;
}

export function getUpcomingFollowUpCount(leads: Lead[], today: string) {
  return leads.filter(
    (lead) =>
      lead.stage !== "closed_lost" &&
      lead.stage !== "enrolled" &&
      !!lead.follow_up_date &&
      lead.follow_up_date > today
  ).length;
}

export function buildLeadsPageModel({
  baseLeads,
  draggedLeadId,
  optimisticLeads,
  programs,
  selectedLeadId,
  today,
}: LeadsPageModelInput): LeadsPageModel {
  const activePrograms = programs.filter((program) => !program.archived_at);
  const programById = new Map(programs.map((program) => [program.id, program]));
  const leads = mergeOptimisticLeads(baseLeads, optimisticLeads);
  const selectedLead = leads.find((lead) => lead.id === selectedLeadId) ?? null;
  const draggedLeadRecord = leads.find((lead) => lead.id === draggedLeadId) ?? null;
  const leadsByStage = groupLeadsByStage(leads);
  const lostLeads = getLostLeads(leads);
  const followUpQueue = getDueFollowUpQueue(leads, today);
  const dueTodayCount = getDueTodayCount(followUpQueue, today);

  return {
    activePrograms,
    draggedLeadRecord,
    dueTodayCount,
    enrolledCount: leads.filter((lead) => lead.stage === "enrolled").length,
    followUpQueue,
    leads,
    leadsByStage,
    lostLeads,
    overdueCount: followUpQueue.length - dueTodayCount,
    programById,
    selectedLead,
    totalActive: leads.filter((lead) => lead.stage !== "closed_lost").length,
    upcomingFollowUps: getUpcomingFollowUpCount(leads, today),
  };
}

export function getLeadFollowUpInputValue(
  lead: Lead,
  followUpDrafts: Record<string, string>,
  fallbackDate: string
) {
  return followUpDrafts[lead.id] ?? lead.follow_up_date ?? fallbackDate;
}

export function buildOptimisticLeadUpdate(
  lead: Lead,
  updates: Partial<Lead>,
  updatedAt = new Date().toISOString()
) {
  return {
    ...lead,
    ...updates,
    updated_at: updatedAt,
  };
}

export function removeOptimisticLeadUpdate(
  optimisticLeads: Record<string, Lead>,
  leadId: string
) {
  if (!(leadId in optimisticLeads)) {
    return optimisticLeads;
  }

  const next = { ...optimisticLeads };
  delete next[leadId];
  return next;
}

export function buildLeadUpdateSuccessMessage(lead: Lead, updates: Partial<Lead>) {
  if (updates.stage) {
    return `${fullName(lead)} moved to ${getStageLabel(updates.stage)}.`;
  }

  if ("follow_up_date" in updates) {
    return `Follow-up updated for ${fullName(lead)}.`;
  }

  return `${fullName(lead)} updated.`;
}
