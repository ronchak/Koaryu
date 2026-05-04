"use client";

import { Header } from "@/components/header";
import { ProgramBadge } from "@/components/programs/program-picker";
import { toLocalDateKey } from "@/lib/date";
import { buildStudentInactivityRows, isStudentOnHoldNow } from "@/lib/student-insights";
import {
  useBeltStore,
  useLeadStore,
  useProgramStore,
  useScheduleStore,
  useStudentStore,
  useStudioStore,
} from "@/lib/store";
import {
  ArrowRight,
  Award,
  BarChart3,
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  TrendingDown,
  TrendingUp,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { BeltLadder, BeltRank, Program } from "@/types";

/* ─── Quick actions config ────────────────────── */

const QUICK_ACTIONS = [
  { label: "Add Student", href: "/students", icon: Users },
  { label: "Import CSV", href: "/students/import", icon: Clock },
  { label: "View Leads", href: "/leads", icon: UserPlus },
  { label: "Reports", href: "/reports", icon: TrendingUp },
];

/* ─── Helpers ─────────────────────────────────── */

function formatDate(value?: string) {
  if (!value) return "—";

  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function subtractDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() - days);
  return toLocalDateKey(date);
}

function formatPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }

  return `${Math.round(value * 100)}%`;
}

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function studentStartDate(student: { membership_start_date?: string; created_at: string }) {
  return student.membership_start_date || student.created_at.slice(0, 10);
}

/* ─── Stat Card ───────────────────────────────── */

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  href,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
  accent?: string;
}) {
  const content = (
    <div
      className={`
        group relative bg-surface border border-border p-5
        transition-colors duration-150
        ${href ? "hover:border-[color:var(--accent)]/30 cursor-pointer" : ""}
      `}
    >
      {href && (
        <span
          className="absolute top-0 left-0 right-0 h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-150"
          style={{ backgroundColor: accent || "var(--accent)" }}
        />
      )}

      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-8 h-8 flex items-center justify-center"
          style={{ backgroundColor: accent ? `${accent}12` : "var(--surface-raised)" }}
        >
          <Icon className="w-4 h-4" style={{ color: accent || "var(--text-secondary)" }} />
        </div>
        <span className="text-[11px] text-muted font-medium uppercase tracking-widest">
          {label}
        </span>
      </div>
      <p className="text-3xl font-bold text-text-primary font-mono leading-none">{value}</p>
      {sub && <p className="text-xs text-muted mt-2 leading-relaxed">{sub}</p>}
    </div>
  );

  if (href) return <Link href={href}>{content}</Link>;
  return content;
}

/* ─── Segment Bar ─────────────────────────────── */

interface MetricSegment {
  label: string;
  value: string | number;
  color: string;
  href?: string;
}

interface KpiBreakdownRow {
  id: string;
  label: string;
  value: string | number;
  detail: string;
  children?: KpiBreakdownRow[];
}

interface KpiBreakdownSection {
  id: string;
  label: string;
  color?: string | null;
  rows: KpiBreakdownRow[];
}

interface KpiInsight {
  id: string;
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub: string;
  accent: string;
  summary: string;
  measures: string;
  calculation: string;
  read: string;
  breakdownTitle: string;
  breakdownEmpty: string;
  breakdownSections: KpiBreakdownSection[];
}

interface BeltBreakdownTarget {
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

function formatPercentParts(numerator: number, denominator: number) {
  return denominator > 0 ? formatPercent(numerator / denominator) : "—";
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

function buildRankFamilyIndex(
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
  student: {
    program_id?: string;
    current_belt_rank_id?: string;
    program_memberships?: {
      status: string;
      program_id: string;
      program_name?: string | null;
      program_color_hex?: string | null;
      ended_at?: string | null;
      current_belt_rank_id?: string | null;
      current_belt_rank_name?: string | null;
    }[];
  },
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
  student: {
    program_id?: string;
    current_belt_rank_id?: string;
    program_memberships?: {
      status: string;
      program_id: string;
      program_name?: string | null;
      program_color_hex?: string | null;
      ended_at?: string | null;
      current_belt_rank_id?: string | null;
      current_belt_rank_name?: string | null;
    }[];
  },
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

function SegmentedMetricBar({
  segments,
}: {
  segments: MetricSegment[];
}) {
  const columnClass = segments.length === 3
    ? "grid-cols-1 sm:grid-cols-3"
    : "grid-cols-2 sm:grid-cols-4";

  return (
    <div className={`grid ${columnClass} gap-px border border-border bg-border`}>
      {segments.map((segment) => (
        <MetricSegmentCell key={segment.label} segment={segment} />
      ))}
    </div>
  );
}

function MetricSegmentCell({ segment }: { segment: MetricSegment }) {
  const content = (
    <>
      <span
        className="absolute top-0 left-0 right-0 h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        style={{ backgroundColor: segment.color }}
      />
      <span
        className="w-2 h-2 shrink-0"
        style={{ backgroundColor: segment.color }}
      />
      <div className="min-w-0">
        <p className="text-lg font-mono font-bold text-text-primary leading-none">
          {segment.value}
        </p>
        <p className="text-[11px] text-muted mt-1 uppercase tracking-wide">
          {segment.label}
        </p>
      </div>
    </>
  );

  if (segment.href) {
    return (
      <Link
        href={segment.href}
        className="group relative flex items-center gap-3 bg-surface px-4 py-3.5 hover:bg-surface-raised/50 transition-colors"
      >
        {content}
      </Link>
    );
  }

  return (
    <div className="group relative flex items-center gap-3 bg-surface px-4 py-3.5 hover:bg-surface-raised/50 transition-colors">
      {content}
    </div>
  );
}

/* ─── Panel wrapper ───────────────────────────── */

function Panel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-surface border border-border p-5 ${className}`}>
      {children}
    </div>
  );
}

function PanelHeader({
  title,
  subtitle,
  href,
  linkLabel = "View all",
}: {
  title: string;
  subtitle?: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {subtitle && (
          <p className="text-xs text-text-secondary mt-1 leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {href && (
        <Link
          href={href}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover shrink-0 transition-colors"
        >
          {linkLabel}
          <ArrowRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}

function MetricStripSection({
  title,
  subtitle,
  segments,
}: {
  title: string;
  subtitle: string;
  segments: MetricSegment[];
}) {
  return (
    <Panel>
      <PanelHeader title={title} subtitle={subtitle} />
      <SegmentedMetricBar segments={segments} />
    </Panel>
  );
}

function KpiTile({
  insight,
  onOpen,
}: {
  insight: KpiInsight;
  onOpen: () => void;
}) {
  const Icon = insight.icon;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative cursor-pointer bg-surface px-4 py-4 text-left transition-colors hover:bg-surface-raised/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      aria-label={`Explain ${insight.label}`}
    >
      <span
        className="absolute top-0 left-0 right-0 h-[2px] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        style={{ backgroundColor: insight.accent }}
      />
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-8 h-8 flex items-center justify-center"
          style={{ backgroundColor: `${insight.accent}12` }}
        >
          <Icon className="w-4 h-4" style={{ color: insight.accent }} />
        </div>
        <span className="text-[11px] text-muted font-medium uppercase tracking-widest">
          {insight.label}
        </span>
      </div>
      <p className="text-2xl font-bold text-text-primary font-mono leading-none">{insight.value}</p>
      <p className="text-xs text-muted mt-2 leading-relaxed">{insight.sub}</p>
    </button>
  );
}

function KpiInsightModal({
  insight,
  onClose,
}: {
  insight: KpiInsight | null;
  onClose: () => void;
}) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(insight?.breakdownSections.map((section) => `${insight.id}:${section.id}`) ?? [])
  );
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  if (!insight) {
    return null;
  }

  const Icon = insight.icon;
  const toggleSection = (sectionId: string) => {
    const key = `${insight.id}:${sectionId}`;
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  const toggleRow = (rowId: string) => {
    const key = `${insight.id}:${rowId}`;
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  const beltGroupCount = insight.breakdownSections.reduce(
    (count, section) => count + section.rows.length,
    0
  );
  const stripeRowCount = insight.breakdownSections.reduce(
    (count, section) =>
      count + section.rows.reduce((rowCount, row) => rowCount + (row.children?.length ?? 0), 0),
    0
  );

  return (
    <div className="koaryu-modal-root p-4 sm:p-6">
      <div
        className="koaryu-modal-backdrop"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kpi-insight-title"
        className="koaryu-modal-panel flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-[6px] border border-border bg-bg shadow-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 flex items-center justify-center"
                style={{ backgroundColor: `${insight.accent}12` }}
              >
                <Icon className="w-4 h-4" style={{ color: insight.accent }} />
              </div>
              <div>
                <h2 id="kpi-insight-title" className="text-base font-semibold text-text-primary">
                  {insight.label}
                </h2>
                <p className="mt-1 text-xs text-muted">
                  Current value: <span className="font-mono text-text-secondary">{insight.value}</span> · {insight.sub}
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] p-1 text-muted transition-colors hover:bg-surface-raised hover:text-text-primary"
            aria-label="Close KPI explanation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[300px_1fr]">
          <aside className="min-h-0 border-b border-border bg-surface/50 lg:border-b-0 lg:border-r">
            <div className="space-y-5 px-5 py-5 lg:max-h-full lg:overflow-y-auto">
              <div className="border border-border bg-bg px-3 py-3">
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Current value</p>
                <p className="mt-2 font-mono text-3xl font-bold leading-none text-text-primary">
                  {insight.value}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted">{insight.sub}</p>
              </div>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">What it is</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{insight.summary}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Measures</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{insight.measures}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Calculation</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{insight.calculation}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Good / Bad</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{insight.read}</p>
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 flex-col">
            <div className="shrink-0 border-b border-border px-5 py-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-widest text-muted">
                    Operational breakdown
                  </p>
                  <h3 className="mt-1 text-lg font-semibold text-text-primary">{insight.breakdownTitle}</h3>
                </div>
                <div className="flex gap-4 text-right">
                  <div>
                    <p className="font-mono text-lg font-semibold leading-none text-text-primary">
                      {beltGroupCount}
                    </p>
                    <p className="mt-1 text-[10px] uppercase tracking-widest text-muted">belt groups</p>
                  </div>
                  <div>
                    <p className="font-mono text-lg font-semibold leading-none text-text-primary">
                      {stripeRowCount}
                    </p>
                    <p className="mt-1 text-[10px] uppercase tracking-widest text-muted">stripe rows</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              {beltGroupCount === 0 ? (
                <div className="border border-border bg-surface px-4 py-8 text-center text-sm leading-6 text-text-secondary">
                  {insight.breakdownEmpty}
                </div>
              ) : (
                <div className="grid gap-4">
                  {insight.breakdownSections.map((section) => {
                    const isSectionExpanded = expandedSections.has(`${insight.id}:${section.id}`);

                    return (
                      <section
                        key={section.id}
                        className="overflow-hidden border border-border bg-surface"
                      >
                        <button
                          type="button"
                          aria-expanded={isSectionExpanded}
                          onClick={() => toggleSection(section.id)}
                          className="group flex w-full items-center justify-between gap-4 border-b border-border bg-bg px-4 py-3 text-left transition-colors hover:bg-surface-raised/50"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-border bg-surface text-muted transition-colors group-hover:text-text-secondary">
                              {isSectionExpanded
                                ? <ChevronDown className="h-3.5 w-3.5" />
                                : <ChevronRight className="h-3.5 w-3.5" />}
                            </span>
                            <span
                              className="h-2.5 w-2.5 shrink-0"
                              style={{ backgroundColor: section.color || "var(--muted)" }}
                            />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-text-primary">
                                {section.label}
                              </p>
                              <p className="mt-0.5 text-[11px] uppercase tracking-widest text-muted">
                                Program
                              </p>
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="font-mono text-sm font-semibold text-text-primary">
                              {section.rows.length}
                            </p>
                            <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted">
                              belts
                            </p>
                          </div>
                        </button>

                        {isSectionExpanded && (
                          <div className="grid gap-px bg-border">
                            {section.rows.map((row) => {
                              const children = row.children ?? [];
                              const hasChildren = children.length > 0;
                              const isExpanded = expandedRows.has(`${insight.id}:${row.id}`);

                              return (
                                <div key={row.id} className="bg-surface">
                                  {hasChildren ? (
                                    <button
                                      type="button"
                                      aria-expanded={isExpanded}
                                      onClick={() => toggleRow(row.id)}
                                      className="group flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-surface-raised/50"
                                    >
                                      <div className="flex min-w-0 items-center gap-3">
                                        <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-border bg-bg text-muted transition-colors group-hover:text-text-secondary">
                                          {isExpanded
                                            ? <ChevronDown className="h-3.5 w-3.5" />
                                            : <ChevronRight className="h-3.5 w-3.5" />}
                                        </span>
                                        <div className="min-w-0">
                                          <p className="truncate text-base font-semibold text-text-primary">{row.label}</p>
                                          <p className="mt-1 text-xs text-muted">{row.detail}</p>
                                        </div>
                                      </div>
                                      <p className="shrink-0 font-mono text-2xl font-bold leading-none text-text-primary">
                                        {row.value}
                                      </p>
                                    </button>
                                  ) : (
                                    <div className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left">
                                      <div className="min-w-0">
                                        <p className="truncate text-base font-semibold text-text-primary">{row.label}</p>
                                        <p className="mt-1 text-xs text-muted">{row.detail}</p>
                                      </div>
                                      <p className="shrink-0 font-mono text-2xl font-bold leading-none text-text-primary">
                                        {row.value}
                                      </p>
                                    </div>
                                  )}

                                  {hasChildren && isExpanded && (
                                    <div className="grid gap-px border-t border-border bg-border">
                                      {children.map((child) => (
                                        <div
                                          key={child.id}
                                          className="flex items-center justify-between gap-4 bg-bg px-4 py-3 pl-14"
                                        >
                                          <div className="min-w-0">
                                            <p className="truncate text-sm font-medium text-text-secondary">{child.label}</p>
                                            <p className="mt-1 text-xs text-muted">{child.detail}</p>
                                          </div>
                                          <p className="shrink-0 font-mono text-base font-semibold text-text-primary">
                                            {child.value}
                                          </p>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ─── Page ────────────────────────────────────── */

export default function DashboardPage() {
  const { studioName } = useStudioStore();
  const { students, studentsLoaded } = useStudentStore();
  const { leads } = useLeadStore();
  const { programs } = useProgramStore();
  const { sessions, attendance } = useScheduleStore();
  const { beltLadders, beltRanks, eligibility, subRankTerm } = useBeltStore();
  const [activeKpiInsight, setActiveKpiInsight] = useState<KpiInsight | null>(null);
  const isInitialDashboardLoading = !studentsLoaded;
  const today = toLocalDateKey();
  const lookback14 = useMemo(() => subtractDays(today, 14), [today]);
  const lookback30 = useMemo(() => subtractDays(today, 30), [today]);
  const lookback90 = useMemo(() => subtractDays(today, 90), [today]);
  const yearStart = useMemo(() => `${today.slice(0, 4)}-01-01`, [today]);
  const programById = useMemo(
    () => new Map(programs.map((program) => [program.id, program])),
    [programs]
  );
  const rankNameById = useMemo(
    () => new Map(
      (beltLadders.length > 0 ? beltLadders.flatMap((ladder) => ladder.ranks) : beltRanks)
        .map((rank) => [rank.id, rank.name])
    ),
    [beltLadders, beltRanks]
  );
  const rankFamilyById = useMemo(
    () => buildRankFamilyIndex(beltLadders, programById),
    [beltLadders, programById]
  );

  const studentStats = useMemo(() => {
    let activeStudents = 0;
    let trialingStudents = 0;
    let onHoldStudents = 0;

    for (const student of students) {
      if (student.status === "active" || student.status === "trialing") {
        activeStudents += 1;
      }

      if (student.status === "trialing") {
        trialingStudents += 1;
      }

      if (isStudentOnHoldNow(student, today)) {
        onHoldStudents += 1;
      }
    }

    return {
      totalStudents: students.length,
      activeStudents,
      trialingStudents,
      onHoldStudents,
    };
  }, [students, today]);

  const leadStats = useMemo(() => {
    let activeLeads = 0;
    let enrolledLeads = 0;
    let dueTodayLeads = 0;

    for (const lead of leads) {
      if (lead.stage === "enrolled") {
        enrolledLeads += 1;
        continue;
      }

      if (lead.stage === "closed_lost") {
        continue;
      }

      activeLeads += 1;

      if (lead.follow_up_date && lead.follow_up_date <= today) {
        dueTodayLeads += 1;
      }
    }

    return { activeLeads, enrolledLeads, dueTodayLeads };
  }, [leads, today]);

  const todaySessions = useMemo(
    () => sessions.reduce((count, session) => count + (session.date === today ? 1 : 0), 0),
    [sessions, today]
  );

  const beltStats = useMemo(() => {
    let beltCount = 0;
    let tipCount = 0;

    for (const rank of beltRanks) {
      if (rank.is_tip) {
        tipCount += 1;
      } else {
        beltCount += 1;
      }
    }

    return { beltCount, tipCount };
  }, [beltRanks]);

  const inactivityRows = useMemo(
    () => buildStudentInactivityRows(students, sessions, attendance, today),
    [attendance, sessions, students, today]
  );

  const inactivityStats = useMemo(() => {
    let watch14 = 0;
    let watch30 = 0;
    let watch90 = 0;
    const highestRiskStudents: typeof inactivityRows = [];

    for (const row of inactivityRows) {
      if (row.daysInactive >= 14) {
        watch14 += 1;

        if (highestRiskStudents.length < 5) {
          highestRiskStudents.push(row);
        }
      }

      if (row.daysInactive >= 30) {
        watch30 += 1;
      }

      if (row.daysInactive >= 90) {
        watch90 += 1;
      }
    }

    return { watch14, watch30, watch90, highestRiskStudents };
  }, [inactivityRows]);

  const newStudentStats = useMemo(() => {
    let new14 = 0;
    let new30 = 0;
    let new90 = 0;
    let newYearToDate = 0;

    for (const student of students) {
      if (student.status !== "active" && student.status !== "trialing" && student.status !== "paused") {
        continue;
      }

      const startDate = studentStartDate(student);
      if (startDate > today) {
        continue;
      }

      if (startDate >= lookback14) {
        new14 += 1;
      }

      if (startDate >= lookback30) {
        new30 += 1;
      }

      if (startDate >= lookback90) {
        new90 += 1;
      }

      if (startDate >= yearStart) {
        newYearToDate += 1;
      }
    }

    return { new14, new30, new90, newYearToDate };
  }, [lookback14, lookback30, lookback90, students, today, yearStart]);

  const operationalStats = useMemo(() => {
    const attendanceBySession = new Map<string, number>();

    for (const record of attendance) {
      if (record.status === "absent") {
        continue;
      }

      attendanceBySession.set(
        record.session_id,
        (attendanceBySession.get(record.session_id) ?? 0) + 1
      );
    }

    let attendanceWithCapacity = 0;
    let totalCapacity = 0;
    let totalCheckIns = 0;
    let sessionsTracked = 0;
    let sessionsWithCapacity = 0;

    for (const session of sessions) {
      if (
        session.status === "canceled" ||
        session.date < lookback30 ||
        session.date > today
      ) {
        continue;
      }

      const attendees = attendanceBySession.get(session.id) ?? session.attendance_count ?? 0;
      totalCheckIns += attendees;
      sessionsTracked += 1;

      if (session.capacity && session.capacity > 0) {
        attendanceWithCapacity += attendees;
        totalCapacity += session.capacity;
        sessionsWithCapacity += 1;
      }
    }

    return {
      attendanceWithCapacity,
      totalCapacity,
      sessionsTracked,
      sessionsWithCapacity,
      utilizationRate: totalCapacity > 0 ? attendanceWithCapacity / totalCapacity : null,
      averageAttendance: sessionsTracked > 0 ? totalCheckIns / sessionsTracked : 0,
    };
  }, [attendance, lookback30, sessions, today]);

  const churnStats = useMemo(() => {
    let inactiveStudents = 0;
    let canceledStudents = 0;

    for (const student of students) {
      if (student.status === "inactive") {
        inactiveStudents += 1;
      } else if (student.status === "canceled") {
        canceledStudents += 1;
      }
    }

    const churnMarkedStudents = inactiveStudents + canceledStudents;

    return {
      inactiveStudents,
      canceledStudents,
      churnMarkedStudents,
      churnRate: students.length > 0 ? churnMarkedStudents / students.length : null,
    };
  }, [students]);

  const testReadinessStats = useMemo(() => {
    let readyToTest = 0;
    let needsApproval = 0;

    for (const entry of eligibility) {
      if (entry.is_eligible) {
        readyToTest += 1;
      } else if (entry.classes_met && entry.time_met && entry.needs_approval) {
        needsApproval += 1;
      }
    }

    return { readyToTest, needsApproval };
  }, [eligibility]);

  const kpiBreakdowns = useMemo(() => {
    const studentById = new Map(students.map((student) => [student.id, student]));
    const capacitySessionById = new Map<string, typeof sessions[number]>();
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
        (row) => `${row.detailA} inactive · ${row.detailB} canceled`
      ),
      cancellations: groupedBreakdownSections(
        cancellationsByBelt,
        (row) => row.value,
        (row) => formatCount(row.value, "canceled student")
      ),
    };
  }, [attendance, eligibility, lookback30, programById, rankFamilyById, rankNameById, sessions, students, today]);

  const recentStudents = useMemo(() => students.slice(0, 5), [students]);

  const programBuckets = useMemo(() => {
    const rows = new Map<string, {
      programId: string | null;
      label: string;
      activeStudents: number;
      trialingStudents: number;
      activeLeads: number;
      todaySessions: number;
    }>();

    for (const program of programs.filter((item) => !item.archived_at)) {
      rows.set(program.id, {
        programId: program.id,
        label: program.name,
        activeStudents: 0,
        trialingStudents: 0,
        activeLeads: 0,
        todaySessions: 0,
      });
    }

    const ensureRow = (programId: string | null, fallback: string) => {
      const key = programId || "unassigned";
      const existing = rows.get(key);
      if (existing) {
        return existing;
      }

      const program = programId ? programById.get(programId) : null;
      const row = {
        programId,
        label: program?.name || fallback,
        activeStudents: 0,
        trialingStudents: 0,
        activeLeads: 0,
        todaySessions: 0,
      };
      rows.set(key, row);
      return row;
    };

    for (const student of students) {
      const memberships = student.program_memberships?.filter((membership) => membership.status === "active") ?? [];
      const programIds = memberships.length > 0
        ? memberships.map((membership) => membership.program_id)
        : [student.program_id || null];

      for (const programId of programIds) {
        const row = ensureRow(programId, "No program");
        if (student.status === "active") {
          row.activeStudents += 1;
        } else if (student.status === "trialing") {
          row.trialingStudents += 1;
        }
      }
    }

    for (const lead of leads) {
      if (lead.stage === "closed_lost" || lead.stage === "enrolled") {
        continue;
      }

      ensureRow(lead.program_id || null, lead.program_interest || "No program").activeLeads += 1;
    }

    for (const session of sessions) {
      if (session.date !== today || session.status === "canceled") {
        continue;
      }

      ensureRow(session.program_id || null, "No program").todaySessions += 1;
    }

    return Array.from(rows.values())
      .filter((row) => row.activeStudents > 0 || row.trialingStudents > 0 || row.activeLeads > 0 || row.todaySessions > 0)
      .sort((a, b) =>
        b.activeStudents + b.trialingStudents + b.activeLeads + b.todaySessions -
        (a.activeStudents + a.trialingStudents + a.activeLeads + a.todaySessions)
      )
      .slice(0, 5);
  }, [leads, programById, programs, sessions, students, today]);

  const inactiveSegments: MetricSegment[] = [
    { label: "14+ inactive", value: inactivityStats.watch14, color: "#F59E0B", href: "/students?inactiveDays=14" },
    { label: "30+ inactive", value: inactivityStats.watch30, color: "#EF4444", href: "/students?inactiveDays=30" },
    { label: "90+ inactive", value: inactivityStats.watch90, color: "#B91C1C", href: "/students?inactiveDays=90" },
    { label: "On hold", value: studentStats.onHoldStudents, color: "#64748B", href: "/students" },
  ];

  const newStudentSegments: MetricSegment[] = [
    { label: "Last 14 days", value: newStudentStats.new14, color: "#38BDF8", href: "/students?newStudents=14" },
    { label: "Last 30 days", value: newStudentStats.new30, color: "#22C55E", href: "/students?newStudents=30" },
    { label: "Last 90 days", value: newStudentStats.new90, color: "#8B5CF6", href: "/students?newStudents=90" },
    { label: "Year to date", value: newStudentStats.newYearToDate, color: "#F59E0B", href: "/students?newStudents=ytd" },
  ];

  const operationalKpis: KpiInsight[] = [
    {
      id: "class-utilization",
      icon: BarChart3,
      label: "Class Utilization",
      value: formatPercent(operationalStats.utilizationRate),
      sub: operationalStats.sessionsWithCapacity > 0
        ? `${operationalStats.attendanceWithCapacity} check-ins / ${operationalStats.totalCapacity} seats`
        : "Add class capacities to unlock utilization",
      accent: "#38BDF8",
      summary: "A fullness check for classes where capacity has been configured.",
      measures: "How much of the available capacity was used across non-canceled classes in the last 30 days.",
      calculation: operationalStats.sessionsWithCapacity > 0
        ? `Koaryu looks at non-canceled sessions from ${formatDate(lookback30)} through ${formatDate(today)} that have a capacity, counts attendance records that are not marked absent, and divides ${operationalStats.attendanceWithCapacity} check-ins by ${operationalStats.totalCapacity} available seats. In the belt breakdown, capacity is counted once for each class where that belt family had attendance, then compared against check-ins from that belt family.`
        : "Koaryu needs class capacity values before it can calculate utilization. Sessions without capacity are left out of this percentage.",
      read: "Good usually means classes are comfortably full without being packed. Very low utilization can mean underfilled classes or too many time slots; very high utilization can mean classes are crowded and may need another session or a larger capacity.",
      breakdownTitle: "Breakdown by belt level",
      breakdownEmpty: "No capacity-tracked attendance is available by belt level yet.",
      breakdownSections: kpiBreakdowns.classUtilization,
    },
    {
      id: "students-ready-to-test",
      icon: Award,
      label: "Students Ready to Test",
      value: testReadinessStats.readyToTest,
      sub: `${testReadinessStats.needsApproval} awaiting instructor approval`,
      accent: "#22C55E",
      summary: "A belt-progression snapshot showing who can be promoted based on the configured ladder rules.",
      measures: "Student eligibility entries where the next-rank class, time, and approval requirements are satisfied.",
      calculation: `Koaryu counts eligibility rows where the belt engine marks is_eligible as true. The subline separately counts rows where class and time requirements are met, but the next rank still requires manual instructor approval.`,
      read: "Good means there are students moving through the curriculum and not getting stuck. Zero can be fine right after a test cycle, but if it stays zero for a long time, check whether belt requirements are too strict or attendance is too low.",
      breakdownTitle: "Breakdown by belt level",
      breakdownEmpty: "No students are currently ready to test by belt level.",
      breakdownSections: kpiBreakdowns.readyToTest,
    },
    {
      id: "churn-watch",
      icon: TrendingDown,
      label: "Churn Watch",
      value: formatPercent(churnStats.churnRate),
      sub: `${churnStats.inactiveStudents} inactive · ${churnStats.canceledStudents} canceled`,
      accent: "#F59E0B",
      summary: "A current roster-health signal for students who have moved out of active participation.",
      measures: "The share of all student records currently marked inactive or canceled.",
      calculation: `Koaryu adds ${churnStats.inactiveStudents} inactive students and ${churnStats.canceledStudents} canceled students, then divides that total by ${students.length} student records. This is a current-status metric, not a date-bounded churn cohort.`,
      read: "Lower is better. A rising number means more of the roster has drifted out of active participation, so it is worth checking missed classes, payment issues, and recent cancellations.",
      breakdownTitle: "Breakdown by belt level",
      breakdownEmpty: "No inactive or canceled students are currently assigned to belt levels.",
      breakdownSections: kpiBreakdowns.churnWatch,
    },
    {
      id: "cancellations",
      icon: UserMinus,
      label: "Cancellations",
      value: churnStats.canceledStudents,
      sub: `${churnStats.churnMarkedStudents} inactive or canceled records`,
      accent: "#EF4444",
      summary: "A count of student records that have been explicitly marked canceled.",
      measures: "Students whose current membership status is canceled.",
      calculation: `Koaryu scans the roster and counts every student with status set to canceled. The supporting text includes inactive plus canceled records so the cancellation count can be read alongside the broader churn watch.`,
      read: "Lower is better. A few cancellations are normal, but a growing count means you should look for patterns: program fit, pricing objections, schedule issues, or students who went inactive before canceling.",
      breakdownTitle: "Breakdown by belt level",
      breakdownEmpty: "No canceled student records are currently assigned to belt levels.",
      breakdownSections: kpiBreakdowns.cancellations,
    },
  ];

  return (
    <>
      <Header
        title="Dashboard"
        description={studioName || (isInitialDashboardLoading ? "Loading studio..." : "Your studio at a glance.")}
      />
      <div className="flex-1 p-6 sm:p-8">
        <div className="max-w-6xl">
          {isInitialDashboardLoading ? (
            <Panel>
              <PanelHeader
                title="Loading Dashboard"
                subtitle="Preparing the first roster, lead, program, and belt snapshot."
              />
              <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
                {["Students", "Leads", "Classes", "Belts"].map((label) => (
                  <div key={label} className="bg-surface px-4 py-4">
                    <div className="h-3 w-20 bg-surface-raised" />
                    <div className="mt-4 h-8 w-14 bg-surface-raised" />
                    <div className="mt-3 h-3 w-28 bg-surface-raised" />
                  </div>
                ))}
              </div>
            </Panel>
          ) : (
            <>

          {/* ── Primary Stats ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border mb-6">
            <StatCard
              icon={Users}
              label="Total Students"
              value={studentStats.totalStudents}
              sub={`${studentStats.activeStudents} active · ${studentStats.trialingStudents} trialing`}
              href="/students"
              accent="#3B82F6"
            />
            <StatCard
              icon={UserPlus}
              label="Active Leads"
              value={leadStats.activeLeads}
              sub={`${leadStats.dueTodayLeads} follow-ups due · ${leadStats.enrolledLeads} enrolled`}
              href="/leads"
              accent="#8B5CF6"
            />
            <StatCard
              icon={Calendar}
              label="Today's Classes"
              value={todaySessions}
              sub={
                todaySessions === 0
                  ? "No classes scheduled"
                  : `${todaySessions} session${todaySessions > 1 ? "s" : ""} today`
              }
              href="/schedule"
              accent="#F59E0B"
            />
            <StatCard
              icon={Award}
              label="Belt Ranks"
              value={beltStats.beltCount}
              sub={`${beltStats.tipCount} ${subRankTerm.toLowerCase()}s configured`}
              href="/belt-tracker"
              accent="#22C55E"
            />
          </div>

          {/* ── Student Movement ── */}
          <div className="grid gap-3 mb-6">
            <MetricStripSection
              title="Inactive Students"
              subtitle="Active and trialing students whose attendance crossed each threshold. Current holds are counted separately."
              segments={inactiveSegments}
            />
            <MetricStripSection
              title="New Students"
              subtitle="Current active, trialing, or paused students with membership starts in each lookback window."
              segments={newStudentSegments}
            />
          </div>

          {/* ── Inactivity Watch + Quick Actions ── */}
          <div className="grid gap-px bg-border lg:grid-cols-[1.2fr_0.8fr] mb-6">
            <Panel>
              <PanelHeader
                title="Inactivity Watch"
                subtitle="Active and trialing students only. Current holds are excluded automatically."
                href="/reports"
                linkLabel="Open reports"
              />

              {inactivityStats.highestRiskStudents.length === 0 ? (
                <div className="border border-border bg-surface-raised/40 px-4 py-5 text-sm text-text-secondary">
                  No active students have crossed the 14-day inactivity threshold right now.
                </div>
              ) : (
                <div className="space-y-1">
                  {inactivityStats.highestRiskStudents.map((row) => (
                    <Link
                      key={row.student.id}
                      href={`/students/${row.student.id}`}
                      className="group relative flex items-center justify-between gap-4 border border-border bg-surface-raised/40 px-4 py-3 hover:border-[color:var(--accent)]/30 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary">
                          {row.student.preferred_name || row.student.legal_first_name} {row.student.legal_last_name}
                        </p>
                        <p className="text-xs text-text-secondary mt-1">
                          {row.lastAttendanceDate
                            ? `Last attended ${formatDate(row.lastAttendanceDate)}`
                            : `No attendance yet · member since ${formatDate(row.referenceDate)}`}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-lg font-mono font-semibold text-text-primary">{row.daysInactive}</p>
                        <p className="text-[10px] text-muted uppercase tracking-widest">days</p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Panel>

            <Panel>
              <PanelHeader title="Quick Actions" />
              <div className="grid grid-cols-2 gap-2">
                {QUICK_ACTIONS.map((action) => (
                  <Link
                    key={action.label}
                    href={action.href}
                    className="group relative flex items-center gap-2.5 px-4 py-3 bg-surface-raised/60 border border-border hover:border-[color:var(--accent)]/30 transition-colors text-sm text-text-secondary hover:text-text-primary"
                  >
                    <action.icon className="w-3.5 h-3.5 text-muted group-hover:text-accent transition-colors" />
                    {action.label}
                  </Link>
                ))}
              </div>
            </Panel>
          </div>

          {/* ── Operational KPIs ── */}
          <Panel className="mb-6">
            <PanelHeader
              title="Operational KPIs"
              subtitle="30-day class utilization, test readiness, and current churn markers."
              href="/reports"
              linkLabel="View reports"
            />
            <div className="grid gap-px bg-border md:grid-cols-2 xl:grid-cols-4">
              {operationalKpis.map((insight) => (
                <KpiTile
                  key={insight.id}
                  insight={insight}
                  onOpen={() => setActiveKpiInsight(insight)}
                />
              ))}
            </div>
          </Panel>

          {/* ── Program Buckets ── */}
          <Panel className="mb-6">
            <PanelHeader
              title="Program Buckets"
              subtitle="Active students, open leads, and today's classes grouped by program."
              href="/reports"
              linkLabel="View reports"
            />

            {programBuckets.length === 0 ? (
              <div className="border border-border bg-surface-raised/40 px-4 py-5 text-sm text-text-secondary">
                Program activity will appear here once students, leads, or classes are assigned.
              </div>
            ) : (
              <div className="grid gap-px bg-border md:grid-cols-2 xl:grid-cols-3">
                {programBuckets.map((row) => (
                  <div
                    key={row.programId || row.label}
                    className="bg-surface px-4 py-4"
                  >
                    <ProgramBadge
                      program={row.programId ? programById.get(row.programId) : null}
                      fallback={row.label}
                    />
                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <p className="font-mono text-base font-semibold text-text-primary">
                          {row.activeStudents + row.trialingStudents}
                        </p>
                        <p className="text-muted mt-0.5">students</p>
                      </div>
                      <div>
                        <p className="font-mono text-base font-semibold text-text-primary">{row.activeLeads}</p>
                        <p className="text-muted mt-0.5">leads</p>
                      </div>
                      <div>
                        <p className="font-mono text-base font-semibold text-text-primary">{row.todaySessions}</p>
                        <p className="text-muted mt-0.5">today</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* ── Recent Students ── */}
          {students.length > 0 && (
            <Panel>
              <PanelHeader
                title="Recent Students"
                href="/students"
              />
              <div className="divide-y divide-border border-t border-border">
                {recentStudents.map((student) => (
                  <Link
                    key={student.id}
                    href={`/students/${student.id}`}
                    className="flex items-center justify-between py-3 hover:bg-surface-raised/40 transition-colors -mx-5 px-5"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-7 h-7 bg-surface-raised border border-border flex items-center justify-center flex-shrink-0">
                        <span className="text-[10px] font-medium text-text-secondary">
                          {student.legal_first_name[0]}
                          {student.legal_last_name[0]}
                        </span>
                      </div>
                      <span className="text-sm text-text-primary truncate">
                        {student.preferred_name || student.legal_first_name} {student.legal_last_name}
                      </span>
                    </div>
                    <span
                      className={`text-[11px] px-2 py-0.5 font-medium uppercase tracking-wide ${
                        student.status === "active"
                          ? "text-success bg-success/10"
                          : student.status === "trialing"
                            ? "text-accent bg-accent/10"
                            : student.status === "paused"
                              ? "text-warning bg-warning/10"
                              : "text-muted bg-surface-raised"
                      }`}
                    >
                      {student.status}
                    </span>
                  </Link>
                ))}
              </div>
            </Panel>
          )}
            </>
          )}
        </div>
      </div>
      <KpiInsightModal
        key={activeKpiInsight?.id ?? "closed"}
        insight={activeKpiInsight}
        onClose={() => setActiveKpiInsight(null)}
      />
    </>
  );
}
