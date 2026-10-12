"use client";

import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import { STUDENT_STATUS_DISPLAY } from "@/components/students/student-status";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StudentRosterStatusFilter } from "@/lib/student-list-page";
import type { SortDir, SortKey } from "@/lib/students-page-model";
import type { Program, StudentStatus } from "@/types";
import { AlertTriangle, Clock, Search, Sparkles, Trash2, X } from "lucide-react";
import styles from "./student-records.module.css";

export type StudentRosterBulkPanel = "tags" | "status" | "delete";

const STATUS_VALUES: StudentStatus[] = ["active", "trialing", "paused", "inactive", "canceled"];

const STATUS_OPTIONS: { value: StudentStatus; label: string }[] = STATUS_VALUES.map((value) => ({
  value,
  label: STUDENT_STATUS_DISPLAY[value].label,
}));

const STATUS_LENSES: { value: StudentRosterStatusFilter | ""; label: string }[] = [
  { value: "", label: "Everyone" },
  ...STATUS_OPTIONS,
];

export function StudentRosterNotices({
  actionMessage,
  fullRosterRequested,
  hasNewStudentFilter,
  inactivityThreshold,
  isNewStudentYtd,
  newStudentDays,
  newStudentStartDate,
  onDismissActionMessage,
  onDismissRosterQueryNotice,
}: {
  actionMessage: string | null;
  fullRosterRequested: boolean;
  hasNewStudentFilter: boolean;
  inactivityThreshold: number | null;
  isNewStudentYtd: boolean;
  newStudentDays: number | null;
  newStudentStartDate: string | null;
  onDismissActionMessage: () => void;
  onDismissRosterQueryNotice: () => void;
}) {
  const hasNotice =
    Boolean(inactivityThreshold) ||
    (hasNewStudentFilter && Boolean(newStudentStartDate)) ||
    fullRosterRequested ||
    Boolean(actionMessage);
  if (!hasNotice) return null;
  return (
    <div className={styles.rosterNotices}>
      {inactivityThreshold ? (
        <DismissibleNotice tone="warning" onDismiss={onDismissRosterQueryNotice}>
          <p className="text-sm text-text-primary">
            Showing students not seen for {inactivityThreshold}+ days. Students on hold are left
            out.
          </p>
        </DismissibleNotice>
      ) : null}

      {hasNewStudentFilter && newStudentStartDate ? (
        <DismissibleNotice tone="success" onDismiss={onDismissRosterQueryNotice}>
          <p className="text-sm text-text-primary">
            {isNewStudentYtd
              ? "Showing students who joined this year, by membership start date."
              : `Showing students who joined in the last ${newStudentDays} days, by membership start date.`}
          </p>
        </DismissibleNotice>
      ) : null}

      {fullRosterRequested ? (
        <DismissibleNotice tone="warning" onDismiss={onDismissRosterQueryNotice}>
          <div className="text-text-primary">
            <p className="text-sm font-semibold text-text-primary">
              Full roster requested for dashboard details
            </p>
            <p className="mt-0.5 text-[0.8125rem] text-text-secondary">
              This request includes all student records needed for retention and churn details.
            </p>
          </div>
        </DismissibleNotice>
      ) : null}

      {actionMessage ? (
        <DismissibleNotice tone="success" onDismiss={onDismissActionMessage}>
          {actionMessage}
        </DismissibleNotice>
      ) : null}
    </div>
  );
}

/**
 * The roster's head, on the header's ridge: every status one tap away (the status
 * filter itself), the two follow-up lists Home links to, then program and search.
 * It stays at the top of the window while the roster scrolls under the side spine.
 */
export function StudentRosterToolbar({
  activeBulkPanel,
  allSelected,
  canManageRoster,
  hasActiveFilters,
  hasNewStudentFilter,
  inactivityThreshold,
  isBulkCommandPending,
  isNewStudentYtd,
  isRosterRefreshing,
  newStudentDays,
  onClearFilters,
  onProgramFilterChange,
  onSearchChange,
  onSort,
  onStatusFilterChange,
  onToggleBulkPanel,
  onToggleSelectAll,
  programFilter,
  programs,
  search,
  selectedCount,
  sortDir,
  sortKey,
  statusFilter,
}: {
  activeBulkPanel: StudentRosterBulkPanel | null;
  allSelected: boolean;
  canManageRoster: boolean;
  hasActiveFilters?: boolean;
  hasNewStudentFilter: boolean;
  inactivityThreshold: number | null;
  isBulkCommandPending: boolean;
  isNewStudentYtd: boolean;
  isRosterRefreshing: boolean;
  newStudentDays: number | null;
  onClearFilters?: () => void;
  onProgramFilterChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onSort: (key: SortKey) => void;
  onStatusFilterChange: (value: StudentRosterStatusFilter | "") => void;
  onToggleBulkPanel: (panel: StudentRosterBulkPanel) => void;
  onToggleSelectAll: () => void;
  programFilter: string;
  programs: Program[];
  search: string;
  selectedCount: number;
  sortDir: SortDir;
  sortKey: SortKey;
  statusFilter: StudentRosterStatusFilter | "";
}) {
  const inactiveLabel = `Not seen ${inactivityThreshold ?? 14}+ days`;
  const newLabel = isNewStudentYtd ? "New this year" : `New in ${newStudentDays ?? 30} days`;
  const currentPrograms = programs.filter((program) => !program.archived_at);
  const bulkButtonClass = (active: boolean) =>
    `${styles.selectionAction} ${active ? styles.selectionActionActive : ""}`;
  const selectAllLabel = allSelected
    ? "Deselect all visible students"
    : "Select all visible students";
  return (
    <div className={styles.rosterToolbar}>
      <nav className={styles.rosterControls} aria-label="Roster views">
        {/* One strip of views: it scrolls sideways when it is wider than the sheet. */}
        <div className={styles.lensStrip}>
          <div role="radiogroup" aria-label="Filter by status" className={styles.lensGroup}>
            {STATUS_LENSES.map((lens) => {
              const checked = statusFilter === lens.value;
              const tone = lens.value ? STUDENT_STATUS_DISPLAY[lens.value].tone : undefined;
              return (
                <button
                  key={lens.value || "all"}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={isBulkCommandPending}
                  onClick={() => onStatusFilterChange(lens.value)}
                  className={styles.lens}
                  data-tone={tone}
                >
                  {tone ? <span aria-hidden="true" className={styles.lensDot} /> : null}
                  {lens.label}
                </button>
              );
            })}
          </div>
          <div className={styles.lensFollowUps}>
            <Link
              href={inactivityThreshold ? "/students" : "/students?inactiveDays=14"}
              className={styles.lensLink}
              aria-current={inactivityThreshold ? "true" : undefined}
              title={inactivityThreshold ? "Show everyone again" : undefined}
            >
              <Clock aria-hidden="true" />
              {inactiveLabel}
              {inactivityThreshold ? (
                <X aria-hidden="true" className={styles.lensLinkClear} />
              ) : null}
            </Link>
            <Link
              href={hasNewStudentFilter ? "/students" : "/students?newStudents=30"}
              className={styles.lensLink}
              aria-current={hasNewStudentFilter ? "true" : undefined}
              title={hasNewStudentFilter ? "Show everyone again" : undefined}
            >
              <Sparkles aria-hidden="true" />
              {newLabel}
              {hasNewStudentFilter ? (
                <X aria-hidden="true" className={styles.lensLinkClear} />
              ) : null}
            </Link>
          </div>
        </div>

        {currentPrograms.length > 1 ? (
          <select
            aria-label="Filter by program"
            value={programFilter}
            onChange={(event) => onProgramFilterChange(event.target.value)}
            disabled={isBulkCommandPending}
            className={`${styles.rosterFilterSelect} ${styles.rosterProgramSelect}`}
          >
            <option value="">All programs</option>
            {currentPrograms.map((program) => (
              <option key={program.id} value={program.id}>
                {program.name}
              </option>
            ))}
          </select>
        ) : null}

        <div className={styles.rosterSearchField}>
          <Search aria-hidden="true" className={styles.rosterSearchIcon} />
          <input
            type="text"
            aria-label="Search students"
            placeholder="Search students"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            disabled={isBulkCommandPending}
            className={styles.rosterSearchInput}
          />
        </div>

        {/* Phones only: the column headers sort everywhere else. */}
        <div className={styles.mobileSortControl}>
          <select
            aria-label="Sort students by"
            value={sortKey}
            onChange={(event) => onSort(event.target.value as SortKey)}
            disabled={isBulkCommandPending}
            className={styles.rosterFilterSelect}
          >
            <option value="name">Name</option>
            <option value="status">Status</option>
            <option value="membership_start_date">Member since</option>
            <option value="created_at">Created</option>
          </select>
          <button
            type="button"
            aria-label={`Sort ${sortDir === "asc" ? "descending" : "ascending"}`}
            onClick={() => onSort(sortKey)}
            disabled={isBulkCommandPending}
            className={styles.mobileSortDirection}
          >
            {sortDir === "asc" ? "A–Z" : "Z–A"}
          </button>
        </div>

        {hasActiveFilters ? (
          <div className={styles.rosterToolbarEnd}>
            {hasActiveFilters && onClearFilters ? (
              <button
                type="button"
                onClick={onClearFilters}
                disabled={isBulkCommandPending}
                className={styles.clearFilters}
              >
                <X aria-hidden="true" />
                Clear filters
              </button>
            ) : null}
          </div>
        ) : null}
        {isRosterRefreshing ? (
          <span role="status" className="sr-only">
            Updating roster…
          </span>
        ) : null}
      </nav>

      {canManageRoster && selectedCount > 0 ? (
        <div className={styles.selectionBand}>
          {/* Phones only: the column-head checkbox selects everyone above that. */}
          <button
            type="button"
            onClick={onToggleSelectAll}
            disabled={isBulkCommandPending}
            aria-label={selectAllLabel}
            className={`${styles.selectionAction} ${styles.selectionSelectAll}`}
          >
            {allSelected ? "Deselect all" : "Select all"}
          </button>
          <span className={styles.selectionCount}>{selectedCount} selected</span>
          <button
            type="button"
            onClick={() => onToggleBulkPanel("tags")}
            disabled={isBulkCommandPending}
            className={bulkButtonClass(activeBulkPanel === "tags")}
          >
            Add tag
          </button>
          <button
            type="button"
            onClick={() => onToggleBulkPanel("status")}
            disabled={isBulkCommandPending}
            className={bulkButtonClass(activeBulkPanel === "status")}
          >
            Change status
          </button>
          <button
            type="button"
            onClick={() => onToggleBulkPanel("delete")}
            disabled={isBulkCommandPending}
            className={`${styles.selectionAction} ${styles.selectionActionDanger}`}
          >
            Archive
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function StudentRosterBulkActionPanels({
  activeBulkPanel,
  bulkActionError,
  bulkStatus,
  deleteError,
  isAddingTags,
  isBulkCommandPending,
  isDeleting,
  isUpdatingStatus,
  onAddTags,
  onBulkStatusChange,
  onBulkStatusUpdate,
  onCancelDelete,
  onCancelStatus,
  onCancelTags,
  onDeleteSelected,
  onTagInputChange,
  selectedCount,
  tagInput,
}: {
  activeBulkPanel: StudentRosterBulkPanel | null;
  bulkActionError: string | null;
  bulkStatus: StudentStatus;
  deleteError: string | null;
  isAddingTags: boolean;
  isBulkCommandPending: boolean;
  isDeleting: boolean;
  isUpdatingStatus: boolean;
  onAddTags: () => void;
  onBulkStatusChange: (status: StudentStatus) => void;
  onBulkStatusUpdate: () => void;
  onCancelDelete: () => void;
  onCancelStatus: () => void;
  onCancelTags: () => void;
  onDeleteSelected: () => void;
  onTagInputChange: (value: string) => void;
  selectedCount: number;
  tagInput: string;
}) {
  const studentsWord = selectedCount === 1 ? "student" : "students";
  if (activeBulkPanel === "tags" && selectedCount > 0) {
    return (
      <div className={styles.bulkPanel}>
        <div className="min-w-0 flex-1">
          <p className={styles.bulkTitle}>
            Add tags to {selectedCount} selected {studentsWord}
          </p>
          <p className={styles.bulkDetail}>
            Enter one or more comma-separated tags. Existing tags stay in place and duplicates are
            ignored.
          </p>
          <div className="mt-3 max-w-xl">
            <Input
              label="Tags to add"
              placeholder="vip, leadership, needs-follow-up"
              value={tagInput}
              onChange={(event) => onTagInputChange(event.target.value)}
              disabled={isBulkCommandPending}
              error={bulkActionError || undefined}
            />
          </div>
        </div>
        <div className={styles.bulkActions}>
          <Button variant="ghost" size="sm" onClick={onCancelTags} disabled={isBulkCommandPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            isLoading={isAddingTags}
            disabled={isBulkCommandPending}
            onClick={onAddTags}
          >
            Add tag
          </Button>
        </div>
      </div>
    );
  }

  if (activeBulkPanel === "status" && selectedCount > 0) {
    return (
      <div className={styles.bulkPanel}>
        <div className="min-w-0 flex-1">
          <p className={styles.bulkTitle}>
            Change status for {selectedCount} selected {studentsWord}
          </p>
          <p className={styles.bulkDetail}>
            This updates the membership status for every selected student at once.
          </p>
          <div className="mt-3 max-w-xs">
            <label className="text-sm text-text-primary font-semibold" htmlFor="bulk-status">
              New status
            </label>
            <select
              id="bulk-status"
              value={bulkStatus}
              onChange={(event) => onBulkStatusChange(event.target.value as StudentStatus)}
              disabled={isBulkCommandPending}
              className="mt-1.5 w-full text-sm text-text-primary"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {bulkActionError ? <p className="text-xs text-danger mt-2">{bulkActionError}</p> : null}
          </div>
        </div>
        <div className={styles.bulkActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancelStatus}
            disabled={isBulkCommandPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            isLoading={isUpdatingStatus}
            disabled={isBulkCommandPending}
            onClick={onBulkStatusUpdate}
          >
            Change status
          </Button>
        </div>
      </div>
    );
  }

  if ((activeBulkPanel === "delete" || deleteError) && selectedCount > 0) {
    return (
      <div className={styles.bulkPanel} data-tone="alert">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <AlertTriangle aria-hidden="true" className="w-4 h-4 text-danger flex-shrink-0" />
            <p className={styles.bulkTitle}>
              Archive {selectedCount} selected {studentsWord}?
            </p>
          </div>
          <p className={styles.bulkDetail}>
            This removes the selected students from the active roster and cannot be undone from the
            UI.
          </p>
          {deleteError ? <p className="text-xs text-danger mt-2">{deleteError}</p> : null}
        </div>
        <div className={styles.bulkActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancelDelete}
            disabled={isBulkCommandPending}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            isLoading={isDeleting}
            disabled={isBulkCommandPending}
            onClick={onDeleteSelected}
          >
            <Trash2 aria-hidden="true" className="w-3.5 h-3.5" />
            Archive
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
