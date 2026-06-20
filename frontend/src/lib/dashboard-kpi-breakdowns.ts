import type { KpiBreakdownSection } from "@/components/dashboard/kpi-insight-modal";
import type { AttendanceRecord, BeltLadder, BeltRank, ClassSession, EligibilityEntry, Program, Student } from "@/types";

export interface BeltBreakdownTarget {
  sectionId: string;
  sectionLabel: string;
  sectionColor?: string | null;
  sectionOrder: number;
  groupId: string;
  groupLabel: string;
  groupOrder: number;
  exactId: string;
  exactLabel: string;
  exactOrder: number;
}

interface BreakdownBucket {
  id: string;
  label: string;
  order: number;
  value: number;
  detailA: number;
  detailB: number;
  numerator: number;
  denominator: number;
  children: Map<string, BreakdownBucket>;
}

interface BreakdownSectionBucket {
  id: string;
  label: string;
  color?: string | null;
  order: number;
  rows: Map<string, BreakdownBucket>;
}

interface ProgramBreakdownContext {
  id: string;
  label: string;
  color?: string | null;
  order: number;
}

interface BuildKpiBreakdownsInput {
  attendance: AttendanceRecord[];
  eligibility: EligibilityEntry[];
  lookback30: string;
  programById: Map<string, Program>;
  rankFamilyById: Map<string, BeltBreakdownTarget>;
  rankNameById: Map<string, string>;
  sessions: ClassSession[];
  students: Student[];
  today: string;
}

export interface DashboardKpiBreakdowns {
  classUtilization: KpiBreakdownSection[];
  readyToTest: KpiBreakdownSection[];
  churnWatch: KpiBreakdownSection[];
  cancellations: KpiBreakdownSection[];
}

function createBreakdownBucket(id: string, label: string, order: number): BreakdownBucket {
  return {
    id,
    label,
    order,
    value: 0,
    detailA: 0,
    detailB: 0,
    numerator: 0,
    denominator: 0,
    children: new Map(),
  };
}

function createBreakdownSectionBucket(target: BeltBreakdownTarget): BreakdownSectionBucket {
  return {
    id: target.sectionId,
    label: target.sectionLabel,
    color: target.sectionColor,
    order: target.sectionOrder,
    rows: new Map(),
  };
}

function slugifyLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function formatPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return "\u2014";
  }

  return `${Math.round(value * 100)}%`;
}

function formatPercentParts(numerator: number, denominator: number) {
  return denominator > 0 ? formatPercent(numerator / denominator) : "\u2014";
}

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function inferBeltFamilyName(rankName: string) {
  const trimmed = rankName.trim() || "No belt assigned";

  if (!/\bstripe/i.test(trimmed)) {
    return trimmed;
  }

  return trimmed
    .replace(/\b(?:\d+\s*)?stripes?\s*\d*\b/gi, "Belt")
    .replace(/\s+/g, " ")
    .trim() || trimmed;
}

function programContext(
  programId: string | null | undefined,
  programName: string | null | undefined,
  programColor: string | null | undefined,
  programById: Map<string, Program>
): ProgramBreakdownContext {
  const program = programId ? programById.get(programId) : null;
  const label = program?.name || programName || "No program";
  const id = programId || `program-name:${slugifyLabel(label)}`;

  return {
    id,
    label,
    color: program?.color_hex || programColor || null,
    order: program?.sort_order ?? Number.MAX_SAFE_INTEGER,
  };
}

export function buildRankFamilyIndex(
  ladders: BeltLadder[],
  programById: Map<string, Program>
) {
  const familyByRankId = new Map<string, BeltBreakdownTarget>();

  for (const ladder of ladders) {
    const section = programContext(ladder.program_id, ladder.name, null, programById);
    const orderedRanks = [...ladder.ranks].sort((a, b) => a.display_order - b.display_order);
    let currentBelt: BeltRank | null = null;

    for (const rank of orderedRanks) {
      if (!rank.is_tip) {
        currentBelt = rank;
      }

      const family = currentBelt || rank;
      familyByRankId.set(rank.id, {
        sectionId: section.id,
        sectionLabel: section.label,
        sectionColor: section.color,
        sectionOrder: section.order,
        groupId: `${section.id}:${family.id}`,
        groupLabel: family.name,
        groupOrder: family.display_order,
        exactId: `${section.id}:${rank.id}`,
        exactLabel: rank.name,
        exactOrder: rank.display_order,
      });
    }
  }

  return familyByRankId;
}

function beltBreakdownTarget(
  rankId: string | null | undefined,
  rankName: string | null | undefined,
  rankFamilyById: Map<string, BeltBreakdownTarget>,
  section: ProgramBreakdownContext
): BeltBreakdownTarget {
  if (rankId) {
    const indexed = rankFamilyById.get(rankId);
    if (indexed) {
      return indexed;
    }
  }

  const exactLabel = rankName || "No belt assigned";
  const groupLabel = inferBeltFamilyName(exactLabel);
  const groupId = `${section.id}:belt-name:${slugifyLabel(groupLabel)}`;

  return {
    sectionId: section.id,
    sectionLabel: section.label,
    sectionColor: section.color,
    sectionOrder: section.order,
    groupId,
    groupLabel,
    groupOrder: Number.MAX_SAFE_INTEGER,
    exactId: rankId ? `${section.id}:rank:${rankId}` : `${section.id}:rank-name:${slugifyLabel(exactLabel)}`,
    exactLabel,
    exactOrder: Number.MAX_SAFE_INTEGER,
  };
}

function ensureBreakdownSection(
  map: Map<string, BreakdownSectionBucket>,
  target: BeltBreakdownTarget
) {
  const existing = map.get(target.sectionId);
  if (existing) {
    return existing;
  }

  const section = createBreakdownSectionBucket(target);
  map.set(target.sectionId, section);
  return section;
}

function ensureBreakdownBucket(
  map: Map<string, BreakdownBucket>,
  id: string,
  label: string,
  order: number
) {
  const existing = map.get(id);
  if (existing) {
    return existing;
  }

  const bucket = createBreakdownBucket(id, label, order);
  map.set(id, bucket);
  return bucket;
}

function addCountBreakdown(
  map: Map<string, BreakdownSectionBucket>,
  target: BeltBreakdownTarget,
  detailA = 1,
  detailB = 0
) {
  const value = detailA + detailB;
  const section = ensureBreakdownSection(map, target);
  const parent = ensureBreakdownBucket(section.rows, target.groupId, target.groupLabel, target.groupOrder);
  parent.value += value;
  parent.detailA += detailA;
  parent.detailB += detailB;

  const child = ensureBreakdownBucket(parent.children, target.exactId, target.exactLabel, target.exactOrder);
  child.value += value;
  child.detailA += detailA;
  child.detailB += detailB;
}

function addUtilizationParent(
  map: Map<string, BreakdownSectionBucket>,
  target: BeltBreakdownTarget,
  checkIns: number,
  capacity: number
) {
  const section = ensureBreakdownSection(map, target);
  const parent = ensureBreakdownBucket(section.rows, target.groupId, target.groupLabel, target.groupOrder);
  parent.value += checkIns;
  parent.numerator += checkIns;
  parent.denominator += capacity;
}

function addUtilizationChild(
  map: Map<string, BreakdownSectionBucket>,
  target: BeltBreakdownTarget,
  checkIns: number,
  capacity: number
) {
  const section = ensureBreakdownSection(map, target);
  const parent = ensureBreakdownBucket(section.rows, target.groupId, target.groupLabel, target.groupOrder);
  const child = ensureBreakdownBucket(parent.children, target.exactId, target.exactLabel, target.exactOrder);
  child.value += checkIns;
  child.numerator += checkIns;
  child.denominator += capacity;
}

function compareBreakdownSections(left: BreakdownSectionBucket, right: BreakdownSectionBucket) {
  if (left.order !== right.order) {
    return left.order - right.order;
  }

  return left.label.localeCompare(right.label);
}

function compareBreakdownBuckets(left: BreakdownBucket, right: BreakdownBucket) {
  if (left.order !== right.order) {
    return left.order - right.order;
  }

  return right.value - left.value || left.label.localeCompare(right.label);
}

function groupedBreakdownSections(
  map: Map<string, BreakdownSectionBucket>,
  value: (bucket: BreakdownBucket) => string | number,
  detail: (bucket: BreakdownBucket) => string
): KpiBreakdownSection[] {
  return Array.from(map.values())
    .sort(compareBreakdownSections)
    .map((section) => ({
      id: section.id,
      label: section.label,
      color: section.color,
      rows: Array.from(section.rows.values())
        .sort(compareBreakdownBuckets)
        .map((bucket) => {
          const children = Array.from(bucket.children.values()).sort(compareBreakdownBuckets);
          const visibleChildren = children.some((child) => child.id !== bucket.id)
            ? children.map((child) => ({
              id: child.id,
              label: child.label,
              value: value(child),
              detail: detail(child),
            }))
            : [];

          return {
            id: bucket.id,
            label: bucket.label,
            value: value(bucket),
            detail: detail(bucket),
            children: visibleChildren,
          };
        }),
    }));
}

function studentBeltRankInfo(
  student: Pick<Student, "program_id" | "current_belt_rank_id" | "program_memberships">,
  rankNameById: Map<string, string>,
  preferredProgramId?: string | null
) {
  const activeMemberships = student.program_memberships?.filter(
    (membership) =>
      membership.status === "active" &&
      !membership.ended_at &&
      (membership.current_belt_rank_name || membership.current_belt_rank_id)
  ) ?? [];
  const activeMembership = preferredProgramId
    ? activeMemberships.find((membership) => membership.program_id === preferredProgramId) ?? activeMemberships[0]
    : activeMemberships[0];

  if (activeMembership) {
    return {
      rankId: activeMembership.current_belt_rank_id,
      rankName: activeMembership.current_belt_rank_name ||
        (activeMembership.current_belt_rank_id ? rankNameById.get(activeMembership.current_belt_rank_id) : null),
      programId: activeMembership.program_id,
      programName: activeMembership.program_name,
      programColor: activeMembership.program_color_hex,
    };
  }

  if (student.current_belt_rank_id) {
    return {
      rankId: student.current_belt_rank_id,
      rankName: rankNameById.get(student.current_belt_rank_id),
      programId: preferredProgramId || student.program_id,
      programName: null,
      programColor: null,
    };
  }

  return {
    rankId: null,
    rankName: "No belt assigned",
    programId: preferredProgramId || student.program_id,
    programName: null,
    programColor: null,
  };
}

function studentBeltTarget(
  student: Pick<Student, "program_id" | "current_belt_rank_id" | "program_memberships">,
  rankNameById: Map<string, string>,
  rankFamilyById: Map<string, BeltBreakdownTarget>,
  programById: Map<string, Program>,
  preferredProgramId?: string | null
) {
  const rankInfo = studentBeltRankInfo(student, rankNameById, preferredProgramId);
  return beltBreakdownTarget(
    rankInfo.rankId,
    rankInfo.rankName,
    rankFamilyById,
    programContext(rankInfo.programId, rankInfo.programName, rankInfo.programColor, programById)
  );
}

export function buildKpiBreakdowns({
  attendance,
  eligibility,
  lookback30,
  programById,
  rankFamilyById,
  rankNameById,
  sessions,
  students,
  today,
}: BuildKpiBreakdownsInput): DashboardKpiBreakdowns {
  const studentById = new Map(students.map((student) => [student.id, student]));
  const capacitySessionById = new Map<string, ClassSession>();
  const classUtilizationByBelt = new Map<string, BreakdownSectionBucket>();
  const readyToTestByBelt = new Map<string, BreakdownSectionBucket>();
  const churnByBelt = new Map<string, BreakdownSectionBucket>();
  const cancellationsByBelt = new Map<string, BreakdownSectionBucket>();
  const parentUtilizationBySession = new Map<string, {
    sessionId: string;
    target: BeltBreakdownTarget;
    checkIns: number;
  }>();
  const childUtilizationBySession = new Map<string, {
    sessionId: string;
    target: BeltBreakdownTarget;
    checkIns: number;
  }>();

  for (const session of sessions) {
    if (
      session.status !== "canceled" &&
      session.date >= lookback30 &&
      session.date <= today &&
      session.capacity &&
      session.capacity > 0
    ) {
      capacitySessionById.set(session.id, session);
    }
  }

  for (const record of attendance) {
    const session = capacitySessionById.get(record.session_id);
    if (record.status === "absent" || !session) {
      continue;
    }

    const student = studentById.get(record.student_id);
    if (!student) {
      continue;
    }

    const target = studentBeltTarget(student, rankNameById, rankFamilyById, programById, session.program_id);
    const parentKey = `${record.session_id}:${target.groupId}`;
    const childKey = `${record.session_id}:${target.exactId}`;
    const parentRow = parentUtilizationBySession.get(parentKey) || {
      sessionId: record.session_id,
      target,
      checkIns: 0,
    };
    const childRow = childUtilizationBySession.get(childKey) || {
      sessionId: record.session_id,
      target,
      checkIns: 0,
    };

    parentRow.checkIns += 1;
    childRow.checkIns += 1;
    parentUtilizationBySession.set(parentKey, parentRow);
    childUtilizationBySession.set(childKey, childRow);
  }

  for (const row of parentUtilizationBySession.values()) {
    const capacity = capacitySessionById.get(row.sessionId)?.capacity;
    if (capacity && capacity > 0) {
      addUtilizationParent(classUtilizationByBelt, row.target, row.checkIns, capacity);
    }
  }

  for (const row of childUtilizationBySession.values()) {
    const capacity = capacitySessionById.get(row.sessionId)?.capacity;
    if (capacity && capacity > 0) {
      addUtilizationChild(classUtilizationByBelt, row.target, row.checkIns, capacity);
    }
  }

  for (const entry of eligibility) {
    if (!entry.is_eligible) {
      continue;
    }

    const student = studentById.get(entry.student_id);
    const studentRankInfo = student ? studentBeltRankInfo(student, rankNameById, entry.program_id) : null;
    const target = beltBreakdownTarget(
      entry.current_rank_id || studentRankInfo?.rankId,
      entry.current_rank_name ||
        (entry.current_rank_id ? rankNameById.get(entry.current_rank_id) : null) ||
        studentRankInfo?.rankName ||
        "No belt assigned",
      rankFamilyById,
      programContext(
        entry.program_id || studentRankInfo?.programId,
        studentRankInfo?.programName,
        studentRankInfo?.programColor,
        programById
      )
    );

    addCountBreakdown(readyToTestByBelt, target);
  }

  for (const student of students) {
    const target = studentBeltTarget(student, rankNameById, rankFamilyById, programById);

    if (student.status === "inactive") {
      addCountBreakdown(churnByBelt, target, 1, 0);
    } else if (student.status === "canceled") {
      addCountBreakdown(churnByBelt, target, 0, 1);
      addCountBreakdown(cancellationsByBelt, target);
    }
  }

  return {
    classUtilization: groupedBreakdownSections(
      classUtilizationByBelt,
      (row) => formatPercentParts(row.numerator, row.denominator),
      (row) => row.denominator > 0
        ? `${row.numerator} check-ins / ${row.denominator} seats`
        : "No capacity tracked"
    ),
    readyToTest: groupedBreakdownSections(
      readyToTestByBelt,
      (row) => row.value,
      (row) => `${formatCount(row.value, "student")} ready to test`
    ),
    churnWatch: groupedBreakdownSections(
      churnByBelt,
      (row) => row.value,
      (row) => `${row.detailA} inactive \u00b7 ${row.detailB} canceled`
    ),
    cancellations: groupedBreakdownSections(
      cancellationsByBelt,
      (row) => row.value,
      (row) => formatCount(row.value, "canceled student")
    ),
  };
}
