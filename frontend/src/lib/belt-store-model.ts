import type { BeltLadder, BeltRank, Promotion, Student } from "@/types";

export interface BeltLadderSyncPayload {
  sub_rank_term: string;
  ranks: Array<{
    id?: string;
    name: string;
    color_hex: string;
    display_order: number;
    min_classes: number;
    min_months: number;
    requires_approval: boolean;
    is_tip: boolean;
    tip_color_hex: string | null;
  }>;
}

export function selectBeltLadder(
  ladders: BeltLadder[],
  preferredLadderId?: string | null
): BeltLadder | null {
  if (preferredLadderId) {
    const matched = ladders.find((ladder) => ladder.id === preferredLadderId);
    if (matched) {
      return matched;
    }
  }

  return ladders[0] ?? null;
}

export function sortBeltLadders(ladders: BeltLadder[]): BeltLadder[] {
  return [...ladders].sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export function upsertBeltLadder(ladders: BeltLadder[], nextLadder: BeltLadder): BeltLadder[] {
  const next = ladders.filter((ladder) => ladder.id !== nextLadder.id);
  next.push(nextLadder);
  return sortBeltLadders(next);
}

export function buildPreviewBeltLadderFromRanks(
  currentLadders: BeltLadder[],
  ranks: BeltRank[],
  {
    preferredLadderId,
    fallbackLadder,
    ladderName,
    subRankTerm,
    requestedSubRankTerm,
  }: {
    preferredLadderId?: string | null;
    fallbackLadder: BeltLadder;
    ladderName: string;
    subRankTerm: string;
    requestedSubRankTerm?: string;
  }
): BeltLadder {
  const selectedLadder = selectBeltLadder(currentLadders, preferredLadderId);
  const nextSubRankTerm = requestedSubRankTerm?.trim() || selectedLadder?.sub_rank_term || subRankTerm;

  return {
    ...(selectedLadder || fallbackLadder),
    id: selectedLadder?.id || "mock-ladder",
    name: selectedLadder?.name || ladderName || fallbackLadder.name,
    sub_rank_term: nextSubRankTerm,
    ranks,
  };
}

export function buildBeltLadderSyncPayload(
  ranks: BeltRank[],
  subRankTerm: string
): BeltLadderSyncPayload {
  return {
    sub_rank_term: subRankTerm,
    ranks: ranks.map((rank, index) => ({
      ...(rank.id && !rank.id.startsWith("local-") ? { id: rank.id } : {}),
      name: rank.name,
      color_hex: rank.color_hex,
      display_order: index,
      min_classes: rank.min_classes,
      min_months: rank.min_months,
      requires_approval: rank.requires_approval,
      is_tip: rank.is_tip,
      tip_color_hex: rank.is_tip ? rank.tip_color_hex ?? null : null,
    })),
  };
}

export function updatePreviewLadderSubRankTerm(
  currentLadders: BeltLadder[],
  preferredLadderId: string | null | undefined,
  nextTerm: string
): { selectedLadder: BeltLadder | null; ladders: BeltLadder[] | null } {
  const selectedLadder = selectBeltLadder(currentLadders, preferredLadderId);
  if (!selectedLadder) {
    return { selectedLadder: null, ladders: null };
  }

  return {
    selectedLadder,
    ladders: upsertBeltLadder(currentLadders, {
      ...selectedLadder,
      sub_rank_term: nextTerm,
    }),
  };
}

export function buildPreviewPromotion(
  students: Student[],
  ranks: BeltRank[],
  {
    studentId,
    toRankId,
    notes,
    idFactory,
    now = new Date(),
  }: {
    studentId: string;
    toRankId: string;
    notes?: string;
    idFactory: () => string;
    now?: Date;
  }
): { students: Student[]; promotion: Promotion } {
  const student = students.find((item) => item.id === studentId);
  if (!student) {
    throw new Error("Student not found");
  }

  const targetRank = ranks.find((rank) => rank.id === toRankId);
  if (!targetRank) {
    throw new Error("Target rank not found");
  }

  const nowIso = now.toISOString();
  const promotion: Promotion = {
    id: idFactory(),
    studio_id: student.studio_id,
    student_id: studentId,
    from_rank_id: student.current_belt_rank_id,
    to_rank_id: toRankId,
    promoted_by: "preview-user",
    notes,
    promoted_at: nowIso,
    student_name: student.preferred_name || `${student.legal_first_name} ${student.legal_last_name}`,
    from_rank_name: ranks.find((rank) => rank.id === student.current_belt_rank_id)?.name,
    to_rank_name: targetRank.name,
  };

  return {
    promotion,
    students: students.map((item) =>
      item.id === studentId
        ? { ...item, current_belt_rank_id: toRankId, updated_at: nowIso }
        : item
    ),
  };
}
