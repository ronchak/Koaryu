import type {
  BeltLadder,
  BeltRank,
  EligibilityEntry,
  Promotion,
  Student,
  StudentProgramMembership,
} from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;

function sortRanks(ranks: BeltRank[]): BeltRank[] {
  return [...ranks].sort((left, right) =>
    left.display_order - right.display_order || left.id.localeCompare(right.id)
  );
}

function ranksForLadder(ladder: BeltLadder, beltRanks: BeltRank[]): BeltRank[] {
  const currentRanks = beltRanks.filter((rank) => rank.ladder_id === ladder.id);
  return sortRanks(currentRanks.length > 0 ? currentRanks : ladder.ranks || []);
}

function daysSince(anchor: string | null | undefined, nowMs: number): number {
  if (!anchor) return 0;
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) return 0;
  return Math.max(0, Math.floor((nowMs - anchorMs) / DAY_MS));
}

function activeMemberships(student: Student): StudentProgramMembership[] {
  return (student.program_memberships || []).filter((membership) =>
    (membership.status === "active" || membership.status === "paused") &&
    !membership.ended_at
  );
}

function studentName(student: Student): string {
  return `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`;
}

function matchesMembershipContext(
  item: Pick<EligibilityEntry | Promotion, "student_program_membership_id" | "program_id">,
  student: Student,
  membership: StudentProgramMembership | null,
): boolean {
  if (membership) {
    if (item.student_program_membership_id) {
      return item.student_program_membership_id === membership.id;
    }
    if (item.program_id) {
      return item.program_id === membership.program_id;
    }
    return membership.program_id === student.program_id;
  }

  return !item.student_program_membership_id &&
    (!item.program_id || item.program_id === student.program_id);
}

function latestPromotionAtForRank(
  promotions: Promotion[],
  student: Student,
  membership: StudentProgramMembership | null,
  currentRankId: string | null,
): string | null {
  if (!currentRankId) return null;

  let latest: { promotedAt: string; promotedAtMs: number } | null = null;
  for (const promotion of promotions) {
    if (promotion.to_rank_id !== currentRankId ||
        !matchesMembershipContext(promotion, student, membership)) {
      continue;
    }
    const promotedAtMs = Date.parse(promotion.promoted_at);
    if (Number.isFinite(promotedAtMs) && (!latest || promotedAtMs > latest.promotedAtMs)) {
      latest = { promotedAt: promotion.promoted_at, promotedAtMs };
    }
  }
  return latest?.promotedAt ?? null;
}

export function buildPreviewEligibilityForLadder({
  ladderId,
  beltLadders,
  beltRanks,
  students,
  seedRows = [],
  promotionHistoryByStudent = {},
  nowMs = Date.now(),
}: {
  ladderId?: string | null;
  beltLadders: BeltLadder[];
  beltRanks: BeltRank[];
  students: Student[];
  seedRows?: EligibilityEntry[];
  promotionHistoryByStudent?: Record<string, Promotion[]>;
  nowMs?: number;
}): EligibilityEntry[] {
  const ladder = beltLadders.find((candidate) => candidate.id === ladderId);
  if (!ladder) return [];

  const orderedRanks = ranksForLadder(ladder, beltRanks);
  if (orderedRanks.length === 0) return [];

  const rankById = new Map(orderedRanks.map((rank) => [rank.id, rank]));
  const entries: EligibilityEntry[] = [];

  const addEntry = (
    student: Student,
    membership: StudentProgramMembership | null,
  ) => {
    const programId = membership?.program_id ?? student.program_id;
    const currentRankId = membership?.current_belt_rank_id ?? student.current_belt_rank_id;
    const currentRank = currentRankId ? rankById.get(currentRankId) : undefined;

    if (currentRankId && !currentRank) return;
    if (!currentRank && ladder.program_id && programId !== ladder.program_id) return;

    const currentIndex = currentRank
      ? orderedRanks.findIndex((rank) => rank.id === currentRank.id)
      : -1;
    const nextRank = orderedRanks[currentIndex + 1];
    if (!nextRank) return;

    const promotionAnchor = latestPromotionAtForRank(
      promotionHistoryByStudent[student.id] ?? [],
      student,
      membership,
      currentRank?.id ?? null,
    );
    const seed = seedRows.find((row) =>
      row.student_id === student.id && matchesMembershipContext(row, student, membership)
    );
    const canReuseSeed = !promotionAnchor &&
      seed?.current_rank_id === (currentRank?.id ?? null) &&
      seed.next_rank_id === nextRank.id;
    const classesSincePromo = canReuseSeed ? seed.classes_since_promo : 0;
    const daysAtRank = promotionAnchor
      ? daysSince(promotionAnchor, nowMs)
      : canReuseSeed
        ? seed.days_at_rank
        : daysSince(membership?.started_at ?? student.membership_start_date, nowMs);
    const classesRequired = nextRank.min_classes;
    const daysRequired = nextRank.min_months * 30;
    const classesMet = classesSincePromo >= classesRequired;
    const timeMet = daysAtRank >= daysRequired;

    entries.push({
      student_id: student.id,
      student_program_membership_id: membership?.id ?? null,
      program_id: programId ?? null,
      student_name: studentName(student),
      current_rank_id: currentRank?.id ?? null,
      current_rank_name: currentRank?.name ?? null,
      current_rank_color: currentRank?.color_hex ?? null,
      next_rank_id: nextRank.id,
      next_rank_name: nextRank.name,
      next_rank_color: nextRank.color_hex,
      classes_since_promo: classesSincePromo,
      classes_required: classesRequired,
      days_at_rank: daysAtRank,
      days_required: daysRequired,
      classes_met: classesMet,
      time_met: timeMet,
      needs_approval: nextRank.requires_approval,
      is_eligible: classesMet && timeMet && !nextRank.requires_approval,
    });
  };

  for (const student of students) {
    if (student.status !== "active") continue;
    const memberships = activeMemberships(student);
    if (memberships.length > 0) {
      memberships.forEach((membership) => addEntry(student, membership));
    } else {
      addEntry(student, null);
    }
  }

  return entries;
}
