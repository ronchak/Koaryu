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
}

export interface StudioDataClearResponse {
  studio_name: string;
  counts: DemoResetCounts;
}

export function resolvePreviewLadderHydrationDefaults(
  {
    storedLadders,
    currentLadderId,
    fallbackLadders,
    fallbackLadder,
  }: {
    storedLadders: BeltLadder[];
    currentLadderId?: string | null;
    fallbackLadders: BeltLadder[];
    fallbackLadder: BeltLadder;
  }
): {
  previewLadders: BeltLadder[];
  selectedPreviewLadder: BeltLadder | null;
  defaultRanks: BeltRank[];
  defaultSubRankTerm: string;
  defaultLadderName: string;
} {
  const previewLadders = storedLadders.length ? storedLadders : fallbackLadders;
  const selectedPreviewLadder = (
    currentLadderId
      ? previewLadders.find((ladder) => ladder.id === currentLadderId)
      : null
  ) || previewLadders[0] || null;

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
      : ladder
  );

  return {
    hydratedLadders,
    eligibilityLadderId: selectedPreviewLadder?.id ?? null,
    eligibilityRows: selectedPreviewLadder?.id === primaryEligibilityLadderId ? primaryEligibilityRows : [],
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
  students,
  leads,
  beltRanks,
  sessions,
  attendance,
}: {
  studioName: string;
  students: Student[];
  leads: Lead[];
  beltRanks: BeltRank[];
  sessions: ClassSession[];
  attendance: AttendanceRecord[];
}): StudioDataClearResponse {
  return {
    studio_name: studioName || "My Studio",
    counts: {
      students: students.length,
      leads: leads.length,
      belt_ranks: beltRanks.length,
      class_sessions: sessions.length,
      attendance_records: attendance.length,
    },
  };
}
