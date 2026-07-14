"use client";

import { ProgramBadge } from "@/components/programs/program-picker";
import { StatusBadge } from "@/components/students/status-badge";
import { StudentAvatar } from "@/components/students/student-avatar";
import { Button } from "@/components/ui/button";
import { ModalFrame } from "@/components/ui/modal-frame";
import {
  buildStudentRosterEmptyState,
  formatDate,
  type SortDir,
  type SortKey,
  type StudentRosterRow,
} from "@/lib/students-page-model";
import { stopStudentSelectionPropagation } from "@/lib/student-selection-events";
import type { Program } from "@/types";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Upload,
  User,
  UserPlus,
} from "lucide-react";

export function StudentRosterLoading() {
  return (
    <div className="grid gap-px bg-border">
      {Array.from({ length: 7 }).map((_, index) => (
        <div key={index} className="grid gap-3 bg-surface px-4 py-4 sm:grid-cols-[2fr_1fr_1fr_1fr]">
          <div className="h-4 w-44 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
          <div className="h-4 w-24 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
          <div className="h-4 w-28 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
          <div className="h-4 w-20 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

export function StudentFormLoading() {
  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="w-full max-w-[560px] rounded-[6px] border border-border bg-surface shadow-2xl"
      ariaLabel="Loading student form"
    >
      <div className="border-b border-border px-6 py-4">
        <div className="h-4 w-28 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
      </div>
      <div className="border-b border-border px-6 py-3">
        <div className="h-3 w-52 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
      </div>
      <div className="space-y-4 px-6 py-5">
        <div className="grid grid-cols-2 gap-3">
          <div className="h-10 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
          <div className="h-10 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
        </div>
        <div className="h-10 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
        <div className="h-24 animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none" />
      </div>
    </ModalFrame>
  );
}

function SortIcon({
  col,
  sortKey,
  sortDir,
}: {
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
}) {
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

function getSortState(col: SortKey, sortKey: SortKey, sortDir: SortDir): RosterSortState | undefined {
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
  const fullName = `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`.trim();
  return fullName || row.displayName;
}

export function StudentRosterLoadError({
  activeLoadError,
  onRetry,
}: {
  activeLoadError: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <AlertTriangle aria-hidden="true" className="w-8 h-8 text-danger mb-3" />
      <p className="text-sm text-text-secondary text-center max-w-md">
        Koaryu could not load the student roster right now.
      </p>
      <p className="mt-2 text-xs text-muted text-center max-w-xl break-words">
        {activeLoadError}
      </p>
      <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
        Try again
      </Button>
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
    <div className="flex flex-col items-center justify-center py-20">
      <User aria-hidden="true" className="w-8 h-8 text-muted mb-3" />
      <p className="text-sm text-text-secondary">
        {state.message}
      </p>
      {state.showClearFilters ? (
        <button
          onClick={onClearFilters}
          className="mt-3 text-sm text-accent hover:text-accent-hover cursor-pointer"
        >
          Clear filters
        </button>
      ) : state.showAddStudent || state.showImportCsv ? (
        <div className="mt-4 flex items-center gap-3">
          {state.showAddStudent ? (
            <Button variant="primary" size="sm" onClick={onAddStudent}>
              <UserPlus aria-hidden="true" className="w-3.5 h-3.5" />
              Add student
            </Button>
          ) : null}
          {state.showImportCsv ? (
            <Button variant="secondary" size="sm" onClick={onImportCsv}>
              <Upload aria-hidden="true" className="w-3.5 h-3.5" />
              Import CSV
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function StudentRosterTable({
  allSelected,
  canManageRoster,
  filtered,
  handleSort,
  inactivityByStudentId,
  inactivityThreshold,
  onOpenStudent,
  programs,
  selectedIds,
  sortDir,
  sortKey,
  toggleSelect,
  toggleSelectAll,
}: {
  allSelected: boolean;
  canManageRoster: boolean;
  filtered: StudentRosterRow[];
  handleSort: (key: SortKey) => void;
  inactivityByStudentId: ReadonlyMap<string, string>;
  inactivityThreshold: number | null;
  onOpenStudent: (studentId: string) => void;
  programs: Program[];
  selectedIds: Set<string>;
  sortDir: SortDir;
  sortKey: SortKey;
  toggleSelect: (studentId: string) => void;
  toggleSelectAll: () => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          {canManageRoster ? (
            <th className="w-10 px-4 py-3">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                aria-label={allSelected ? "Deselect all visible students" : "Select all visible students"}
                className="accent-[var(--accent)] cursor-pointer"
              />
            </th>
          ) : null}
          <th
            aria-sort={getSortState("name", sortKey, sortDir)}
            className="px-4 py-3 text-left text-xs font-medium text-text-secondary select-none"
          >
            <button
              type="button"
              onClick={() => handleSort("name")}
              aria-label={getSortButtonLabel("name", "name", sortKey, sortDir)}
              className="flex items-center gap-1 cursor-pointer"
            >
              Name
              <SortIcon col="name" sortKey={sortKey} sortDir={sortDir} />
            </button>
          </th>
          <th
            aria-sort={getSortState("status", sortKey, sortDir)}
            className="px-4 py-3 text-left text-xs font-medium text-text-secondary select-none"
          >
            <button
              type="button"
              onClick={() => handleSort("status")}
              aria-label={getSortButtonLabel("status", "status", sortKey, sortDir)}
              className="flex items-center gap-1 cursor-pointer"
            >
              Status
              <SortIcon col="status" sortKey={sortKey} sortDir={sortDir} />
            </button>
          </th>
          <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">
            Programs
          </th>
          <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">
            Contact
          </th>
          <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">
            Tags
          </th>
          <th
            aria-sort={getSortState("membership_start_date", sortKey, sortDir)}
            className="px-4 py-3 text-left text-xs font-medium text-text-secondary select-none"
          >
            <button
              type="button"
              onClick={() => handleSort("membership_start_date")}
              aria-label={getSortButtonLabel("member since date", "membership_start_date", sortKey, sortDir)}
              className="flex items-center gap-1 cursor-pointer"
            >
              Member since
              <SortIcon col="membership_start_date" sortKey={sortKey} sortDir={sortDir} />
            </button>
          </th>
          {inactivityThreshold && (
            <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">
              Days inactive
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {filtered.map((row, idx) => {
          const { student } = row;
          const isSelected = selectedIds.has(student.id);
          const studentName = getStudentName(row);
          return (
            <tr
              key={student.id}
              onClick={() => onOpenStudent(student.id)}
              className={`
                border-b border-border cursor-pointer
                transition-colors duration-100
                ${isSelected ? "bg-accent/5" : idx % 2 === 0 ? "" : "bg-surface/40"}
                hover:bg-surface-raised
              `}
            >
              {canManageRoster ? (
                <td
                  className="px-4 py-3"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSelect(student.id);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onClick={stopStudentSelectionPropagation}
                    onChange={() => toggleSelect(student.id)}
                    aria-label={isSelected ? `Deselect ${studentName}` : `Select ${studentName}`}
                    className="accent-[var(--accent)] cursor-pointer"
                  />
                </td>
              ) : null}
              <td className="px-4 py-3">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenStudent(student.id);
                  }}
                  aria-label={`Open ${studentName} profile`}
                  className="flex items-center gap-2.5 text-left cursor-pointer"
                >
                  <StudentAvatar student={student} />
                  <div>
                    <p className="font-medium text-text-primary text-sm">
                      {student.preferred_name || student.legal_first_name}{" "}
                      {student.legal_last_name}
                    </p>
                    {student.is_minor && <p className="text-xs text-muted">Minor</p>}
                  </div>
                </button>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={student.status} />
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {row.programs.length > 0 ? (
                    row.programs.map((program) => (
                      <ProgramBadge key={program.id} program={program} />
                    ))
                  ) : (
                    <ProgramBadge program={programs.find((program) => program.id === student.program_id)} />
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-text-secondary font-mono text-xs">
                {row.contact}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {row.visibleTags.map((tag) => (
                    <span
                      key={tag}
                      className="px-1.5 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary"
                    >
                      {tag}
                    </span>
                  ))}
                  {row.hiddenTagCount > 0 && (
                    <span className="text-xs text-muted">
                      +{row.hiddenTagCount}
                    </span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-text-secondary font-mono text-xs">
                {formatDate(student.membership_start_date)}
              </td>
              {inactivityThreshold && (
                <td className="px-4 py-3 text-text-secondary font-mono text-xs">
                  {inactivityByStudentId.get(student.id) || `${inactivityThreshold}+`}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function StudentRosterFooter({
  filteredCount,
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
  if (filteredCount === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border px-8 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted">
        {usesDerivedRosterFilters
          ? `Showing ${filteredCount} of ${studentsCount} students`
          : `Showing ${pageStart}-${pageEnd} of ${pagedTotal} students`}
      </p>
      {!usesDerivedRosterFilters && totalPages > 1 ? (
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onPreviousPage}
            disabled={page <= 1 || isPagedLoading}
          >
            <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            Previous
          </Button>
          <span className="min-w-20 text-center text-xs text-muted">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onNextPage}
            disabled={page >= totalPages || isPagedLoading}
          >
            Next
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
