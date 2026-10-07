import type { ApiAutomationClearEffects } from "@/types/generated/api-contracts";
import type {
  AttendanceRecord,
  BeltLadder,
  BeltRank,
  ClassSession,
  ClassTemplate,
  EligibilityEntry,
  Lead,
  Program,
  Student,
} from "@/types";

export interface DemoResetCounts {
  students: number;
  leads: number;
  belt_ranks: number;
  class_sessions: number;
  attendance_records: number;
}

export interface DemoResetResponse {
  studio_name: string;
  programs?: Program[];
  students: Student[];
  leads: Lead[];
  belt_ladders: BeltLadder[];
  primary_belt_ladder: BeltLadder | null;
  eligibility: EligibilityEntry[];
  templates: ClassTemplate[];
  sessions: ClassSession[];
  attendance: AttendanceRecord[];
  counts: DemoResetCounts;
  automation: ApiAutomationClearEffects;
}

export interface StudioDataClearResponse {
  studio_name: string;
  counts: DemoResetCounts;
  automation: ApiAutomationClearEffects;
}

const automationCountFields = [
  "workflows_paused",
  "workflow_runs_cancelled",
  "workflow_cancellation_intents_added",
  "attendance_deliveries_cancelled",
  "belt_test_events_deleted",
  "belt_test_recipients_deleted",
  "sending_attempts_preserved",
  "unknown_attempts_preserved",
] as const satisfies readonly (keyof ApiAutomationClearEffects)[];

export function isAutomationClearEffects(value: unknown): value is ApiAutomationClearEffects {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const effects = value as Record<string, unknown>;
  return (
    Object.keys(effects).length === 9 &&
    Object.hasOwn(effects, "attendance_rule_paused") &&
    typeof effects.attendance_rule_paused === "boolean" &&
    automationCountFields.every(
      (key) =>
        Object.hasOwn(effects, key) &&
        typeof effects[key] === "number" &&
        Number.isSafeInteger(effects[key]) &&
        effects[key] >= 0,
    )
  );
}

// Illustrative automation effects only. Preview has no live automation execution.
export const PREVIEW_AUTOMATION_CLEAR_EFFECTS: ApiAutomationClearEffects = {
  workflows_paused: 2,
  workflow_runs_cancelled: 3,
  workflow_cancellation_intents_added: 1,
  attendance_deliveries_cancelled: 2,
  belt_test_events_deleted: 1,
  belt_test_recipients_deleted: 4,
  sending_attempts_preserved: 1,
  unknown_attempts_preserved: 1,
  attendance_rule_paused: true,
};

export function resolvePreviewLadderHydrationDefaults({
  storedLadders,
  currentLadderId,
  fallbackLadders,
  fallbackLadder,
}: {
  storedLadders: BeltLadder[];
  currentLadderId?: string | null;
  fallbackLadders: BeltLadder[];
  fallbackLadder: BeltLadder;
}): {
  previewLadders: BeltLadder[];
  selectedPreviewLadder: BeltLadder | null;
  defaultRanks: BeltRank[];
  defaultSubRankTerm: string;
  defaultLadderName: string;
} {
  const previewLadders = storedLadders.length ? storedLadders : fallbackLadders;
  const selectedPreviewLadder =
    (currentLadderId ? previewLadders.find((ladder) => ladder.id === currentLadderId) : null) ||
    previewLadders[0] ||
    null;

  return {
    previewLadders,
    selectedPreviewLadder,
    defaultRanks: selectedPreviewLadder?.ranks || fallbackLadder.ranks,
    defaultSubRankTerm: selectedPreviewLadder?.sub_rank_term || "Stripe",
    defaultLadderName: selectedPreviewLadder?.name || fallbackLadder.name,
  };
}

export function buildPreviewHydratedLadderState({
  previewLadders,
  selectedPreviewLadder,
  storedRanks,
  storedSubRankTerm,
  storedLadderName,
  primaryEligibilityLadderId,
  primaryEligibilityRows,
}: {
  previewLadders: BeltLadder[];
  selectedPreviewLadder: BeltLadder | null;
  storedRanks: BeltRank[];
  storedSubRankTerm: string;
  storedLadderName: string;
  primaryEligibilityLadderId: string;
  primaryEligibilityRows: EligibilityEntry[];
}): {
  hydratedLadders: BeltLadder[];
  eligibilityLadderId: string | null;
  eligibilityRows: EligibilityEntry[];
} {
  const hydratedLadders = previewLadders.map((ladder) =>
    ladder.id === selectedPreviewLadder?.id
      ? { ...ladder, name: storedLadderName, sub_rank_term: storedSubRankTerm, ranks: storedRanks }
      : ladder,
  );

  return {
    hydratedLadders,
    eligibilityLadderId: selectedPreviewLadder?.id ?? null,
    eligibilityRows:
      selectedPreviewLadder?.id === primaryEligibilityLadderId ? primaryEligibilityRows : [],
  };
}

function compareSessionsByDateAndTime(a: ClassSession, b: ClassSession) {
  const dateCompare = a.date.localeCompare(b.date);
  if (dateCompare !== 0) {
    return dateCompare;
  }
  return a.start_time.localeCompare(b.start_time);
}

export function buildPreviewDemoResetResponse({
  studioName,
  automation,
  programs,
  students,
  leads,
  beltLadders,
  primaryBeltLadder,
  eligibility,
  templates,
  sessions,
  attendance,
}: {
  studioName: string;
  automation: ApiAutomationClearEffects;
  programs: Program[];
  students: Student[];
  leads: Lead[];
  beltLadders: BeltLadder[];
  primaryBeltLadder: BeltLadder;
  eligibility: EligibilityEntry[];
  templates: ClassTemplate[];
  sessions: ClassSession[];
  attendance: AttendanceRecord[];
}): DemoResetResponse {
  return {
    studio_name: studioName,
    automation,
    programs,
    students,
    leads,
    belt_ladders: beltLadders,
    primary_belt_ladder: primaryBeltLadder,
    eligibility,
    templates,
    sessions: [...sessions].sort(compareSessionsByDateAndTime),
    attendance,
    counts: {
      students: students.length,
      leads: leads.length,
      belt_ranks: primaryBeltLadder.ranks.length,
      class_sessions: sessions.length,
      attendance_records: attendance.length,
    },
  };
}

export function buildPreviewStudioDataClearResponse({
  studioName,
  automation,
  students,
  leads,
  beltRanks,
  sessions,
  attendance,
}: {
  studioName: string;
  automation: ApiAutomationClearEffects;
  students: Student[];
  leads: Lead[];
  beltRanks: BeltRank[];
  sessions: ClassSession[];
  attendance: AttendanceRecord[];
}): StudioDataClearResponse {
  return {
    studio_name: studioName || "My Studio",
    automation,
    counts: {
      students: students.length,
      leads: leads.length,
      belt_ranks: beltRanks.length,
      class_sessions: sessions.length,
      attendance_records: attendance.length,
    },
  };
}
