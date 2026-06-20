import type { BeltLadder, BeltRank, EligibilityEntry, Program } from "@/types";

export type BeltRankFormInput = {
  color_hex: string;
  min_classes: number;
  min_months: number;
  name: string;
  requires_approval: boolean;
  tip_color_hex?: string;
};

export type BeltGroup = {
  belt: BeltRank;
  tips: BeltRank[];
  collapsed: boolean;
};

export type TipDragPosition = {
  gIdx: number;
  tIdx: number;
};

export type EligibilityGroup = {
  approvalCount: number;
  color?: string;
  eligibleCount: number;
  entries: EligibilityEntry[];
  key: string;
  label: string;
  rank?: BeltRank;
  sortIndex: number;
};

type BeltTrackerProgramStateInput = {
  beltLadders: BeltLadder[];
  currentLadderId: string | null | undefined;
  programs: Program[];
  selectedProgramId: string | null;
  storeBeltRanks: BeltRank[];
};

export type BeltTrackerProgramState = {
  activeLadderRanks: BeltRank[];
  beltPrograms: Program[];
  currentLadder: BeltLadder | null;
  currentProgramReady: boolean;
  currentStoreLadder: BeltLadder | null;
  ladderByProgramId: Map<string, BeltLadder>;
  selectedProgram: Program | null;
};

type BuildRankInput = {
  data: BeltRankFormInput;
  ladderId: string;
  now?: string;
  rankId?: string;
  studioId?: string;
};

type BuildBeltRankInput = BuildRankInput & {
  displayOrder: number;
};

type BuildTipRankInput = BuildRankInput & {
  beltColorHex: string;
};

type PromotionTargetValidationInput = {
  currentLadder: BeltLadder | null;
  promoteEntry: EligibilityEntry;
  selectedProgram: Program | null;
};

export type PromotionRequestBody = {
  notes?: string;
  program_id?: string | null;
  student_id: string;
  student_program_membership_id?: string | null;
  to_rank_id: string;
};

export function createLocalRankId(randomValue = Math.random()) {
  return "local-" + randomValue.toString(36).slice(2, 9);
}

export function buildNewBeltRank({
  data,
  displayOrder,
  ladderId,
  now = new Date().toISOString(),
  rankId = createLocalRankId(),
  studioId = "studio-1",
}: BuildBeltRankInput): BeltRank {
  return {
    id: rankId,
    ladder_id: ladderId,
    studio_id: studioId,
    name: data.name,
    color_hex: data.color_hex,
    is_tip: false,
    tip_color_hex: undefined,
    min_classes: data.min_classes,
    min_months: data.min_months,
    requires_approval: data.requires_approval,
    display_order: displayOrder,
    created_at: now,
  };
}

export function buildNewTipRank({
  beltColorHex,
  data,
  ladderId,
  now = new Date().toISOString(),
  rankId = createLocalRankId(),
  studioId = "studio-1",
}: BuildTipRankInput): BeltRank {
  return {
    id: rankId,
    ladder_id: ladderId,
    studio_id: studioId,
    name: data.name,
    color_hex: beltColorHex,
    is_tip: true,
    tip_color_hex: data.tip_color_hex,
    min_classes: data.min_classes,
    min_months: data.min_months,
    requires_approval: data.requires_approval,
    display_order: 0,
    created_at: now,
  };
}

export function appendTipToGroup(
  groups: BeltGroup[],
  groupIndex: number,
  tipRank: BeltRank
) {
  const nextGroups = cloneGroups(groups);
  const targetGroup = nextGroups[groupIndex];
  if (!targetGroup) {
    return null;
  }

  targetGroup.tips.push(tipRank);
  return flattenGroups(nextGroups);
}

export function updateRankFromForm(
  ranks: BeltRank[],
  rankId: string,
  data: BeltRankFormInput
) {
  return ranks.map((rank) =>
    rank.id === rankId
      ? {
          ...rank,
          name: data.name,
          color_hex: data.color_hex,
          tip_color_hex: rank.is_tip ? data.tip_color_hex : undefined,
          min_classes: data.min_classes,
          min_months: data.min_months,
          requires_approval: data.requires_approval,
        }
      : rank
  );
}

export function normalizeSubRankTermDraft(value: string) {
  return value.trim() || "Stripe";
}

export function buildLoadNoticeDismissalKey(key: string, message: string | null) {
  return message ? `${key}:${message}` : null;
}

export function validatePromotionTarget({
  currentLadder,
  promoteEntry,
  selectedProgram,
}: PromotionTargetValidationInput) {
  const targetRankId = promoteEntry.next_rank_id;
  if (!targetRankId) {
    return "Could not determine the next rank for this promotion.";
  }

  if (!currentLadder?.ranks.some((rank) => rank.id === targetRankId)) {
    return "This promotion target is not part of the current belt ladder.";
  }

  if (selectedProgram?.id && promoteEntry.program_id && promoteEntry.program_id !== selectedProgram.id) {
    return "This student is queued in a different program. Switch programs before promoting.";
  }

  return null;
}

export function buildPromotionRequestBody(
  promoteEntry: EligibilityEntry,
  targetRankId: string,
  notes: string
): PromotionRequestBody {
  return {
    student_id: promoteEntry.student_id,
    to_rank_id: targetRankId,
    student_program_membership_id: promoteEntry.student_program_membership_id,
    program_id: promoteEntry.program_id,
    notes: notes.trim() || undefined,
  };
}

export function buildBeltTrackerProgramState({
  beltLadders,
  currentLadderId,
  programs,
  selectedProgramId,
  storeBeltRanks,
}: BeltTrackerProgramStateInput): BeltTrackerProgramState {
  const beltPrograms = programs.filter((program) => !program.archived_at && !program.is_system);
  const ladderByProgramId = new Map<string, BeltLadder>();

  for (const ladder of beltLadders) {
    if (ladder.program_id && !ladderByProgramId.has(ladder.program_id)) {
      ladderByProgramId.set(ladder.program_id, ladder);
    }
  }

  const currentStoreLadder = beltLadders.find((ladder) => ladder.id === currentLadderId) ?? null;
  const selectedProgram = selectBeltTrackerProgram({
    beltPrograms,
    currentStoreLadder,
    ladderByProgramId,
    selectedProgramId,
  });
  const currentLadder = selectedProgram ? ladderByProgramId.get(selectedProgram.id) ?? null : null;
  const currentProgramReady = Boolean(currentLadder && currentLadder.id === currentLadderId);
  const activeLadderRanks = currentLadder
    ? currentLadder.id === currentLadderId
      ? storeBeltRanks
      : currentLadder.ranks
    : [];

  return {
    activeLadderRanks,
    beltPrograms,
    currentLadder,
    currentProgramReady,
    currentStoreLadder,
    ladderByProgramId,
    selectedProgram,
  };
}

function selectBeltTrackerProgram({
  beltPrograms,
  currentStoreLadder,
  ladderByProgramId,
  selectedProgramId,
}: Pick<
  BeltTrackerProgramState,
  "beltPrograms" | "currentStoreLadder" | "ladderByProgramId"
> & {
  selectedProgramId: string | null;
}) {
  const selected = selectedProgramId
    ? beltPrograms.find((program) => program.id === selectedProgramId)
    : null;
  if (selected) return selected;

  const currentProgram = currentStoreLadder?.program_id
    ? beltPrograms.find((program) => program.id === currentStoreLadder.program_id)
    : null;
  if (currentProgram) return currentProgram;

  return beltPrograms.find((program) => ladderByProgramId.has(program.id)) ?? beltPrograms[0] ?? null;
}

export function groupRanks(ranks: BeltRank[]): BeltGroup[] {
  const groups: BeltGroup[] = [];

  for (const rank of ranks) {
    if (!rank.is_tip) {
      groups.push({ belt: rank, tips: [], collapsed: false });
    } else if (groups.length > 0) {
      groups[groups.length - 1].tips.push(rank);
    }
  }

  return groups;
}

export function flattenGroups(groups: BeltGroup[]): BeltRank[] {
  const flat: BeltRank[] = [];
  let order = 0;

  for (const group of groups) {
    flat.push({ ...group.belt, display_order: order++ });

    for (const tip of group.tips) {
      flat.push({ ...tip, display_order: order++ });
    }
  }

  return flat;
}

function cloneGroups(groups: BeltGroup[]) {
  return groups.map((group) => ({ ...group, tips: [...group.tips] }));
}

export function moveBeltGroup(
  groups: BeltGroup[],
  fromIndex: number | null,
  dropIndex: number
) {
  if (fromIndex === null || fromIndex === dropIndex) {
    return null;
  }

  const nextGroups = cloneGroups(groups);
  const [moved] = nextGroups.splice(fromIndex, 1);
  if (!moved) {
    return null;
  }

  nextGroups.splice(dropIndex, 0, moved);
  return flattenGroups(nextGroups.map((group) => ({ ...group, collapsed: false })));
}

export function moveTipWithinGroup(
  groups: BeltGroup[],
  from: TipDragPosition | null,
  dropGIdx: number,
  dropTIdx: number
) {
  if (!from || (from.gIdx === dropGIdx && from.tIdx === dropTIdx)) {
    return null;
  }

  const nextGroups = cloneGroups(groups);
  if (!nextGroups[dropGIdx] || !nextGroups[from.gIdx]) {
    return null;
  }

  if (from.gIdx === dropGIdx) {
    const tips = nextGroups[dropGIdx].tips;
    const [moved] = tips.splice(from.tIdx, 1);
    if (!moved) {
      return null;
    }
    tips.splice(dropTIdx, 0, moved);
  }

  return flattenGroups(nextGroups);
}

export function deleteRankAndFollowingTips(ranks: BeltRank[], rankId: string) {
  const targetIndex = ranks.findIndex((rank) => rank.id === rankId);
  if (targetIndex === -1) {
    return ranks;
  }

  const targetRank = ranks[targetIndex];
  const idsToDelete = new Set<string>([rankId]);
  if (!targetRank.is_tip) {
    let nextIndex = targetIndex + 1;
    while (nextIndex < ranks.length && ranks[nextIndex].is_tip) {
      idsToDelete.add(ranks[nextIndex].id);
      nextIndex += 1;
    }
  }

  return ranks
    .filter((rank) => !idsToDelete.has(rank.id))
    .map((rank, index) => ({ ...rank, display_order: index }));
}

export function isEligibilityEntryReady(entry: EligibilityEntry) {
  return entry.classes_met && entry.time_met;
}

function getEligibilityProgress(entry: EligibilityEntry) {
  return (
    (entry.classes_required ? entry.classes_since_promo / entry.classes_required : 1) +
    (entry.days_required ? entry.days_at_rank / entry.days_required : 1)
  );
}

function compareEligibilityEntries(left: EligibilityEntry, right: EligibilityEntry) {
  const leftReady = isEligibilityEntryReady(left) ? 1 : 0;
  const rightReady = isEligibilityEntryReady(right) ? 1 : 0;
  if (leftReady !== rightReady) {
    return rightReady - leftReady;
  }

  const leftProgress = getEligibilityProgress(left);
  const rightProgress = getEligibilityProgress(right);
  if (leftProgress !== rightProgress) {
    return rightProgress - leftProgress;
  }

  return left.student_name.localeCompare(right.student_name);
}

export function buildEligibilityGroups(
  visibleEligibility: EligibilityEntry[],
  eligibilityRanks: BeltRank[]
): EligibilityGroup[] {
  const rankOrder = new Map(eligibilityRanks.map((rank, index) => [rank.id, index]));
  const rankById = new Map(eligibilityRanks.map((rank) => [rank.id, rank]));
  const groupsByKey = new Map<string, Omit<EligibilityGroup, "approvalCount" | "eligibleCount">>();

  for (const entry of visibleEligibility) {
    const key = entry.current_rank_id ?? "unranked";
    if (!groupsByKey.has(key)) {
      const rank = entry.current_rank_id ? rankById.get(entry.current_rank_id) : undefined;
      groupsByKey.set(key, {
        color: entry.current_rank_color ?? undefined,
        entries: [],
        key,
        label: entry.current_rank_name ?? "Unranked",
        rank,
        sortIndex: entry.current_rank_id
          ? (rankOrder.get(entry.current_rank_id) ?? Number.MAX_SAFE_INTEGER)
          : -1,
      });
    }

    groupsByKey.get(key)?.entries.push(entry);
  }

  return Array.from(groupsByKey.values())
    .map((group) => {
      const entries = [...group.entries].sort(compareEligibilityEntries);
      return {
        ...group,
        approvalCount: entries.filter(
          (entry) => isEligibilityEntryReady(entry) && entry.needs_approval
        ).length,
        eligibleCount: entries.filter(
          (entry) => isEligibilityEntryReady(entry) && !entry.needs_approval
        ).length,
        entries,
      };
    })
    .sort((left, right) => {
      if (left.sortIndex !== right.sortIndex) {
        return left.sortIndex - right.sortIndex;
      }
      return left.label.localeCompare(right.label);
    });
}
