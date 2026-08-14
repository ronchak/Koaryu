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
    studentProgramMembershipId,
    programId,
    notes,
    idFactory,
    now = new Date(),
  }: {
    studentId: string;
    toRankId: string;
    studentProgramMembershipId?: string | null;
    programId?: string | null;
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
  const rankById = new Map(ranks.map((rank) => [rank.id, rank]));
  const currentMemberships = (student.program_memberships || []).filter((membership) =>
    (membership.status === "active" || membership.status === "paused") &&
    !membership.ended_at
  );
  let targetMembership = studentProgramMembershipId
    ? currentMemberships.find((membership) => membership.id === studentProgramMembershipId)
    : undefined;

  if (studentProgramMembershipId && !targetMembership) {
    throw new Error("Student program membership not found");
  }
  if (!targetMembership && programId) {
    targetMembership = currentMemberships.find((membership) => membership.program_id === programId);
    if (!targetMembership && currentMemberships.length > 0) {
      throw new Error("Student program membership not found");
    }
  }
  if (targetMembership && programId && targetMembership.program_id !== programId) {
    throw new Error("Student program membership does not match program");
  }
  if (!targetMembership && !studentProgramMembershipId && !programId) {
    targetMembership = currentMemberships.find((membership) => {
      const currentRank = membership.current_belt_rank_id
        ? rankById.get(membership.current_belt_rank_id)
        : null;
      return currentRank?.ladder_id === targetRank.ladder_id;
    }) ?? currentMemberships.find((membership) =>
      !membership.current_belt_rank_id && membership.program_id === student.program_id
    );
  }

  const fromRankId = targetMembership
    ? targetMembership.current_belt_rank_id ?? null
    : student.current_belt_rank_id;
  const targetProgramId = targetMembership?.program_id ?? programId ?? student.program_id;
  const promotion: Promotion = {
    id: idFactory(),
    studio_id: student.studio_id,
    student_id: studentId,
    student_program_membership_id: targetMembership?.id ?? null,
    program_id: targetProgramId ?? null,
    from_rank_id: fromRankId,
    to_rank_id: toRankId,
    promoted_by: "preview-user",
    notes,
    promoted_at: nowIso,
    student_name: student.preferred_name || `${student.legal_first_name} ${student.legal_last_name}`,
    from_rank_name: ranks.find((rank) => rank.id === fromRankId)?.name,
    to_rank_name: targetRank.name,
  };

  return {
    promotion,
    students: students.map((item) => {
      if (item.id !== studentId) return item;

      const updatesPrimaryRank = !targetMembership || targetMembership.program_id === item.program_id;
      return {
        ...item,
        current_belt_rank_id: updatesPrimaryRank ? toRankId : item.current_belt_rank_id,
        program_memberships: item.program_memberships?.map((membership) =>
          membership.id === targetMembership?.id
            ? {
                ...membership,
                current_belt_rank_id: toRankId,
                current_belt_rank_name: targetRank.name,
                current_belt_rank_color: targetRank.color_hex,
                updated_at: nowIso,
              }
            : membership
        ),
        updated_at: nowIso,
      };
    }),
  };
}

function sortRanksForRepair(ranks: BeltRank[]): BeltRank[] {
  return [...ranks].sort((left, right) =>
    left.display_order - right.display_order || left.id.localeCompare(right.id)
  );
}

export function repairPreviewStudentRanksForLadder(
  students: Student[],
  ladder: BeltLadder,
  previousRanks: BeltRank[],
  nextRanks: BeltRank[],
  now = new Date()
): Student[] {
  if (!ladder.program_id) return students;

  const orderedPrevious = sortRanksForRepair(previousRanks);
  const orderedNext = sortRanksForRepair(nextRanks);
  const previousById = new Map(orderedPrevious.map((rank) => [rank.id, rank]));
  const nextById = new Map(orderedNext.map((rank) => [rank.id, rank]));
  const previousFullRanks = orderedPrevious.filter((rank) => !rank.is_tip);
  const nextFullRanks = orderedNext.filter((rank) => !rank.is_tip);
  const nowIso = now.toISOString();

  const replacementForDeletedRank = (rankId: string): BeltRank | null => {
    const removedRank = previousById.get(rankId);
    if (!removedRank || nextFullRanks.length === 0) return nextFullRanks[0] ?? null;

    const survivingFullRanks = nextFullRanks
      .map((rank) => ({ rank, previous: previousById.get(rank.id) }))
      .filter((entry): entry is { rank: BeltRank; previous: BeltRank } => Boolean(entry.previous));
    const preceding = survivingFullRanks
      .filter((entry) => entry.previous.display_order <= removedRank.display_order)
      .sort((left, right) => right.previous.display_order - left.previous.display_order)[0];
    if (preceding) return preceding.rank;

    const following = survivingFullRanks
      .filter((entry) => entry.previous.display_order > removedRank.display_order)
      .sort((left, right) => left.previous.display_order - right.previous.display_order)[0];
    return following?.rank ?? nextFullRanks[0] ?? null;
  };

  return students.map((student) => {
    let primaryRankId = student.current_belt_rank_id;
    let changed = false;
    const programMemberships = student.program_memberships?.map((membership) => {
      const isTargetMembership = membership.program_id === ladder.program_id &&
        (membership.status === "active" || membership.status === "paused") &&
        !membership.ended_at;
      if (!isTargetMembership) return membership;

      let nextRank: BeltRank | null | undefined;
      if (!membership.current_belt_rank_id) {
        nextRank = previousFullRanks.length === 0 ? nextFullRanks[0] : undefined;
      } else if (!nextById.has(membership.current_belt_rank_id) && previousById.has(membership.current_belt_rank_id)) {
        nextRank = replacementForDeletedRank(membership.current_belt_rank_id);
      }

      if (nextRank === undefined || (nextRank?.id ?? null) === (membership.current_belt_rank_id ?? null)) {
        return membership;
      }

      changed = true;
      if (membership.program_id === student.program_id) {
        primaryRankId = nextRank?.id ?? null;
      }
      return {
        ...membership,
        current_belt_rank_id: nextRank?.id ?? null,
        current_belt_rank_name: nextRank?.name ?? null,
        current_belt_rank_color: nextRank?.color_hex ?? null,
        updated_at: nowIso,
      };
    });

    return changed
      ? {
          ...student,
          current_belt_rank_id: primaryRankId,
          program_memberships: programMemberships,
          updated_at: nowIso,
        }
      : student;
  });
}
