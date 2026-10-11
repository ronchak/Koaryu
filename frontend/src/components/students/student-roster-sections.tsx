"use client";

import { useMemo } from "react";
import { ProgramBadge } from "@/components/programs/program-picker";
import { StatusBadge } from "@/components/students/status-badge";
import { BeltSwatch } from "@/components/students/student-belt-swatch";
import { StudentAvatar } from "@/components/students/student-avatar";
import { Button } from "@/components/ui/button";
import { CalmState, ToneTag } from "@/components/ui/horizon";
import { ModalFrame } from "@/components/ui/modal-frame";
import { RevealText } from "@/components/ui/reveal-text";
import {
  buildStudentRosterEmptyState,
  formatDate,
  type SortDir,
  type SortKey,
  type StudentRosterRow,
} from "@/lib/students-page-model";
import { stopStudentSelectionPropagation } from "@/lib/student-selection-events";
import type { BeltRank, Program, Student } from "@/types";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  SearchX,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import styles from "./student-records.module.css";

export function StudentFormLoading() {
  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="w-full max-w-[560px] rounded-[18px] bg-surface shadow-[var(--product-shadow-lifted)]"
      ariaLabel="Loading student form"
    >
      <div className="border-b border-border px-6 py-4">
        <div className="h-4 w-28 animate-pulse rounded-[10px] bg-surface-raised motion-reduce:animate-none" />
      </div>
      <div className="border-b border-border px-6 py-3">
        <div className="h-3 w-52 animate-pulse rounded-[10px] bg-surface-raised motion-reduce:animate-none" />
      </div>
      <div className="space-y-4 px-6 py-5">
        <div className="grid grid-cols-2 gap-3">
          <div className="h-10 animate-pulse rounded-[10px] bg-surface-raised motion-reduce:animate-none" />
          <div className="h-10 animate-pulse rounded-[10px] bg-surface-raised motion-reduce:animate-none" />
        </div>
        <div className="h-10 animate-pulse rounded-[10px] bg-surface-raised motion-reduce:animate-none" />
        <div className="h-24 animate-pulse rounded-[10px] bg-surface-raised motion-reduce:animate-none" />
      </div>
    </ModalFrame>
  );
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== col) {
    return <ChevronUp aria-hidden="true" className="w-3 h-3 opacity-20" />;
  }
  return sortDir === "asc" ? (
    <ChevronUp aria-hidden="true" className="w-3 h-3 text-accent" />
  ) : (
    <ChevronDown aria-hidden="true" className="w-3 h-3 text-accent" />
  );
}

type RosterSortState = "ascending" | "descending";

function getSortState(
  col: SortKey,
  sortKey: SortKey,
  sortDir: SortDir,
): RosterSortState | undefined {
  if (sortKey !== col) {
    return undefined;
  }

  return sortDir === "asc" ? "ascending" : "descending";
}

function getSortButtonLabel(label: string, col: SortKey, sortKey: SortKey, sortDir: SortDir) {
  if (sortKey !== col) {
    return `Sort by ${label}`;
  }

  const nextDirection = sortDir === "asc" ? "descending" : "ascending";
  return `Sort by ${label} ${nextDirection}`;
}

function getStudentName(row: StudentRosterRow) {
  const { student } = row;
  const fullName =
    `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`.trim();
  return fullName || row.displayName;
}

type RosterBelt = {
  key: string;
  programName: string;
  programColor: string | null;
  rankName: string | null;
  rankColor: string | null;
};

type RankLookup = ReadonlyMap<string, Pick<BeltRank, "name" | "color_hex">>;

/** Current programs with the belt the student holds in each, from the roster row itself. */
function rosterBelts(row: StudentRosterRow, programs: Program[], ranks: RankLookup): RosterBelt[] {
  const memberships = (row.student.program_memberships ?? []).filter(
    (membership) => membership.status !== "ended" && !membership.ended_at,
  );
  if (memberships.length > 0) {
    return memberships.map((membership) => {
      const program = programs.find((item) => item.id === membership.program_id);
      const rank = membership.current_belt_rank_id
        ? ranks.get(membership.current_belt_rank_id)
        : undefined;
      return {
        key: membership.id,
        programName: program?.name || membership.program_name || "Program",
        programColor: program?.color_hex || membership.program_color_hex || null,
        rankName: membership.current_belt_rank_name || rank?.name || null,
        rankColor: membership.current_belt_rank_color || rank?.color_hex || null,
      };
    });
  }
  const studentRank = row.student.current_belt_rank_id
    ? ranks.get(row.student.current_belt_rank_id)
    : undefined;
  return row.programs.map((program, index) => ({
    key: program.id,
    programName: program.name,
    programColor: program.color_hex,
    rankName: index === 0 ? (studentRank?.name ?? null) : null,
    rankColor: index === 0 ? (studentRank?.color_hex ?? null) : null,
  }));
}

function BeltSummary({
  belts,
  row,
  programs,
}: {
  belts: RosterBelt[];
  row: StudentRosterRow;
  programs: Program[];
}) {
  if (belts.length === 0) {
    const fallback = programs.find((program) => program.id === row.student.program_id);
    return fallback ? (
      <ProgramBadge program={fallback} />
    ) : (
      <span className={styles.quietValue}>No program</span>
    );
  }
  const [first, ...rest] = belts;
  return (
    <div className={styles.beltSummary}>
      <BeltSwatch color={first.rankColor} />
      <div className={styles.beltCopy}>
        <span className={styles.beltRank}>{first.rankName ?? "No rank yet"}</span>
        <span className={styles.beltProgram}>
          <span
            aria-hidden="true"
            className={styles.programDot}
            style={first.programColor ? { backgroundColor: first.programColor } : undefined}
          />
          <RevealText className={styles.beltProgramName} title={first.programName}>
            {first.programName}
          </RevealText>
          {rest.length > 0 ? (
            <span
              className={styles.overflowCount}
              title={rest.map((belt) => belt.programName).join(", ")}
            >
              +{rest.length} more
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** Phones: the first belt and program as one line of words, the program dot between them. */
function PhoneBeltLine({
  belts,
  row,
  programs,
}: {
  belts: RosterBelt[];
  row: StudentRosterRow;
  programs: Program[];
}) {
  if (belts.length === 0) {
    const fallback = programs.find((program) => program.id === row.student.program_id);
    return (
      <span className={styles.phoneBelt}>
        {fallback ? (
          <>
            <span
              aria-hidden="true"
              className={styles.programDot}
              style={fallback.color_hex ? { backgroundColor: fallback.color_hex } : undefined}
            />
            {fallback.name}
          </>
        ) : (
          "No program"
        )}
      </span>
    );
  }
  const [first, ...rest] = belts;
  return (
    <span className={styles.phoneBelt}>
      {first.rankName ?? "No rank yet"}{" "}
      <span
        aria-hidden="true"
        className={styles.programDot}
        style={first.programColor ? { backgroundColor: first.programColor } : undefined}
      />
      {first.programName}
      {rest.length > 0 ? (
        <span
          className={styles.overflowCount}
          title={rest.map((belt) => belt.programName).join(", ")}
        >
          {" "}
          +{rest.length} more
        </span>
      ) : null}
    </span>
  );
}

/** An opened address wraps after its "@", not at its last letter. */
function ContactText({ value }: { value: string }) {
  const at = value.indexOf("@");
  if (at <= 0) return <>{value}</>;
  return (
    <>
      {value.slice(0, at + 1)}
      <wbr />
      {value.slice(at + 1)}
    </>
  );
}

function primaryGuardianName(student: Student) {
  const guardian =
    student.guardians.find((item) => item.is_primary_contact) ?? student.guardians[0];
  return guardian ? `${guardian.first_name} ${guardian.last_name}`.trim() : null;
}

export function StudentRosterLoadError({
  activeLoadError,
  onRetry,
}: {
  activeLoadError: string;
  onRetry: () => void;
}) {
  return (
    <div className={styles.rosterStateBody}>
      <CalmState
        tone="alert"
        icon={<AlertTriangle />}
        title="Koaryu could not load the student roster right now."
        detail={<span className="break-words">{activeLoadError}</span>}
        action={
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    </div>
  );
}

export function StudentRosterEmptyState({
  canCreateStudents,
  canManageRoster,
  hasActiveFilters,
  onAddStudent,
  onClearFilters,
  onImportCsv,
}: {
  canCreateStudents: boolean;
  canManageRoster: boolean;
  hasActiveFilters: boolean;
  onAddStudent: () => void;
  onClearFilters: () => void;
  onImportCsv: () => void;
}) {
  const state = buildStudentRosterEmptyState({
    canCreateStudents,
    canManageRoster,
    hasActiveFilters,
  });

  return (
    <div className={styles.rosterStateBody}>
      <CalmState
        tone="neutral"
        icon={hasActiveFilters ? <SearchX /> : <Users />}
        title={state.message}
        detail={
          hasActiveFilters
            ? "Try a different name or view, or clear the filters to see everyone."
            : state.showImportCsv
              ? "Bring your list across from a spreadsheet, or add students one at a time."
              : undefined
        }
        action={
          state.showClearFilters ? (
            <Button variant="secondary" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : state.showAddStudent || state.showImportCsv ? (
            <div className="flex flex-wrap items-center gap-2">
              {state.showImportCsv ? (
                <Button variant="secondary" size="sm" onClick={onImportCsv}>
                  <Upload aria-hidden="true" className="w-3.5 h-3.5" />
                  Import CSV
                </Button>
              ) : null}
              {state.showAddStudent ? (
                <Button variant="primary" size="sm" onClick={onAddStudent}>
                  <UserPlus aria-hidden="true" className="w-3.5 h-3.5" />
                  Add student
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
    </div>
  );
}

export function StudentRosterTable({
  allSelected,
  beltRanks,
  canManageRoster,
  filtered,
  handleSort,
  inactivityByStudentId,
  inactivityThreshold,
  isBulkCommandPending,
  onOpenStudent,
  onPrefetchStudent,
  placeholderRows = 0,
  programs,
  selectedIds,
  sortDir,
  sortKey,
  toggleSelect,
  toggleSelectAll,
}: {
  allSelected: boolean;
  beltRanks?: readonly BeltRank[];
  canManageRoster: boolean;
  filtered: StudentRosterRow[];
  handleSort: (key: SortKey) => void;
  inactivityByStudentId: ReadonlyMap<string, string>;
  inactivityThreshold: number | null;
  isBulkCommandPending: boolean;
  onOpenStudent: (studentId: string) => void;
  onPrefetchStudent?: (studentId: string) => void;
  /** Cold load: draw this many placeholder rows inside the real table. */
  placeholderRows?: number;
  programs: Program[];
  selectedIds: Set<string>;
  sortDir: SortDir;
  sortKey: SortKey;
  toggleSelect: (studentId: string) => void;
  toggleSelectAll: () => void;
}) {
  const rankById = useMemo<RankLookup>(
    () => new Map((beltRanks ?? []).map((rank) => [rank.id, rank])),
    [beltRanks],
  );
  const sortButtonClass =
    "inline-flex min-h-9 items-center gap-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <table
      className={styles.rosterTable}
      data-selectable={canManageRoster ? "true" : "false"}
      data-inactivity={inactivityThreshold ? "true" : undefined}
    >
      <thead>
        <tr>
          {canManageRoster ? (
            <th data-column="select" className="p-0">
              <label className={styles.checkboxTarget}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  disabled={isBulkCommandPending}
                  className={styles.checkboxControl}
                />
                <span className="sr-only">
                  {allSelected ? "Deselect all visible students" : "Select all visible students"}
                </span>
              </label>
            </th>
          ) : null}
          <th data-column="name" aria-sort={getSortState("name", sortKey, sortDir)}>
            <button
              type="button"
              onClick={() => handleSort("name")}
              aria-label={getSortButtonLabel("name", "name", sortKey, sortDir)}
              disabled={isBulkCommandPending}
              className={sortButtonClass}
            >
              Student
              <SortIcon col="name" sortKey={sortKey} sortDir={sortDir} />
            </button>
          </th>
          <th data-column="programs">Belt &amp; program</th>
          <th data-column="status" aria-sort={getSortState("status", sortKey, sortDir)}>
            <button
              type="button"
              onClick={() => handleSort("status")}
              aria-label={getSortButtonLabel("status", "status", sortKey, sortDir)}
              disabled={isBulkCommandPending}
              className={sortButtonClass}
            >
              Status
              <SortIcon col="status" sortKey={sortKey} sortDir={sortDir} />
            </button>
          </th>
          <th data-column="contact">Contact</th>
          <th
            data-column="member-since"
            aria-sort={getSortState("membership_start_date", sortKey, sortDir)}
          >
            <button
              type="button"
              onClick={() => handleSort("membership_start_date")}
              aria-label={getSortButtonLabel(
                "member since date",
                "membership_start_date",
                sortKey,
                sortDir,
              )}
              disabled={isBulkCommandPending}
              className={sortButtonClass}
            >
              Member since
              <SortIcon col="membership_start_date" sortKey={sortKey} sortDir={sortDir} />
            </button>
          </th>
          {inactivityThreshold ? <th data-column="inactive">Not seen for</th> : null}
          <th data-column="open">
            <span className="sr-only">Open</span>
          </th>
        </tr>
      </thead>
      <tbody className={placeholderRows > 0 ? "koaryu-skeleton-reveal" : undefined}>
        {Array.from({ length: placeholderRows }, (_, index) => (
          <tr
            key={`placeholder-${index}`}
            className={styles.rosterPlaceholderRow}
            aria-hidden="true"
          >
            {canManageRoster ? (
              <td data-cell="select" className="p-0">
                <span className={styles.checkboxTarget}>
                  <span className={styles.placeholderCheckbox} />
                </span>
              </td>
            ) : null}
            <th scope="row" data-cell="name" className={styles.studentCell}>
              <span className={styles.studentIdentityButton}>
                <span className={styles.placeholderAvatar} />
                <span className={styles.placeholderName} data-length={index % 3} />
              </span>
            </th>
            <td data-cell="programs">
              <span className={styles.placeholderBar} data-length={(index + 1) % 3} />
            </td>
            <td data-cell="status">
              <span className={styles.placeholderPill} />
            </td>
            <td data-cell="contact" />
            <td data-cell="since">
              <span className={styles.placeholderDate} />
            </td>
            {inactivityThreshold ? (
              <td data-cell="inactive">
                <span className={styles.placeholderDate} />
              </td>
            ) : null}
            <td data-cell="open" />
          </tr>
        ))}
        {filtered.map((row) => {
          const { student } = row;
          const isSelected = selectedIds.has(student.id);
          const studentName = getStudentName(row);
          const guardianName = student.is_minor ? primaryGuardianName(student) : null;
          const tags = [...row.visibleTags];
          const moreTags = row.hiddenTagCount;
          const hiddenTags = student.tags.slice(tags.length);
          const belts = rosterBelts(row, programs, rankById);
          const firstRankColor = belts.find((belt) => belt.rankColor)?.rankColor ?? null;
          const inactivity = inactivityThreshold
            ? inactivityByStudentId.get(student.id) || `${inactivityThreshold}+`
            : null;
          return (
            <tr
              key={student.id}
              data-student-id={student.id}
              data-state={student.status}
              onFocusCapture={() => onPrefetchStudent?.(student.id)}
              onPointerEnter={() => onPrefetchStudent?.(student.id)}
              onClick={() => onOpenStudent(student.id)}
              className={styles.rosterRow}
              data-selected={isSelected || undefined}
            >
              {canManageRoster ? (
                <td data-cell="select" className="p-0">
                  <label
                    className={styles.checkboxTarget}
                    onClick={stopStudentSelectionPropagation}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onClick={stopStudentSelectionPropagation}
                      onChange={() => toggleSelect(student.id)}
                      disabled={isBulkCommandPending}
                      className={styles.checkboxControl}
                    />
                    <span className="sr-only">
                      {isSelected ? `Deselect ${studentName}` : `Select ${studentName}`}
                    </span>
                  </label>
                </td>
              ) : null}
              <th scope="row" data-cell="name" className={styles.studentCell}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenStudent(student.id);
                  }}
                  data-open-student
                  aria-label={`Open ${studentName} profile`}
                  className={styles.studentIdentityButton}
                >
                  <StudentAvatar student={student} size="sm" ringColor={firstRankColor} />
                  <span className={styles.studentIdentityCopy}>
                    <span className={styles.studentName}>
                      {student.preferred_name || student.legal_first_name} {student.legal_last_name}
                    </span>
                    <PhoneBeltLine belts={belts} row={row} programs={programs} />
                    {student.is_minor || tags.length > 0 ? (
                      <span className={styles.studentMeta}>
                        {student.is_minor ? (
                          // A named guardian already says this is a minor.
                          <span className={styles.studentGuardian}>
                            {guardianName ? `Guardian ${guardianName}` : "Minor"}
                          </span>
                        ) : null}
                        {tags.map((tag) => (
                          <RevealText key={tag} className={styles.rosterTag} title={tag}>
                            {tag}
                          </RevealText>
                        ))}
                        {moreTags > 0 ? (
                          <span
                            className={styles.overflowCount}
                            title={hiddenTags.join(", ") || undefined}
                          >
                            +{moreTags}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                </button>
              </th>
              <td data-cell="programs" className={styles.programCell}>
                <BeltSummary belts={belts} row={row} programs={programs} />
              </td>
              <td data-cell="status" className={styles.statusCell}>
                <StatusBadge status={student.status} />
              </td>
              <td
                data-cell="contact"
                className={styles.contactCell}
                title={row.contact === "—" ? undefined : row.contact}
              >
                {row.contact === "—" ? (
                  <span className={styles.quietValue}>No contact on file</span>
                ) : (
                  <RevealText className={styles.contactText}>
                    <ContactText value={row.contact} />
                  </RevealText>
                )}
              </td>
              <td data-cell="since" className={styles.memberSinceCell}>
                {formatDate(student.membership_start_date)}
              </td>
              {inactivity ? (
                <td data-cell="inactive" className={styles.inactiveCell}>
                  <ToneTag tone="warn">{inactivity} days</ToneTag>
                </td>
              ) : null}
              <td data-cell="open" className={styles.openCell} aria-hidden="true">
                <ChevronRight className="h-4 w-4" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function StudentRosterFooter({
  filteredCount,
  hasNextPage,
  hasPreviousPage,
  isBulkCommandPending,
  isPagedLoading,
  onNextPage,
  onPreviousPage,
  page,
  pageEnd,
  pageStart,
  pagedTotal,
  studentsCount,
  totalPages,
  usesDerivedRosterFilters,
}: {
  filteredCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  isBulkCommandPending: boolean;
  isPagedLoading: boolean;
  onNextPage: () => void;
  onPreviousPage: () => void;
  page: number;
  pageEnd: number;
  pageStart: number;
  pagedTotal: number;
  studentsCount: number;
  totalPages: number;
  usesDerivedRosterFilters: boolean;
}) {
  const isPaged = !usesDerivedRosterFilters && (totalPages > 1 || hasNextPage || hasPreviousPage);
  // The header already says how many; the footer only speaks when it adds a range.
  const total = usesDerivedRosterFilters ? studentsCount : pagedTotal;
  if (filteredCount === 0 || (!isPaged && filteredCount === total)) {
    return null;
  }

  return (
    <div className={styles.rosterFooter}>
      <p>
        {usesDerivedRosterFilters
          ? `Showing ${filteredCount} of ${studentsCount} students`
          : `Showing ${pageStart}-${pageEnd} of ${pagedTotal} students`}
      </p>
      {isPaged ? (
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onPreviousPage}
            disabled={!hasPreviousPage || isPagedLoading || isBulkCommandPending}
          >
            <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            Previous
          </Button>
          <span className="min-w-20 text-center text-[0.8125rem] text-muted tabular-nums">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onNextPage}
            disabled={!hasNextPage || isPagedLoading || isBulkCommandPending}
          >
            Next
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
