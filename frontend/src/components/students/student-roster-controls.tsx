"use client";

import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StudentRosterStatusFilter } from "@/lib/student-list-page";
import type { Program, StudentStatus } from "@/types";
import { AlertTriangle, Search, Trash2 } from "lucide-react";

export type StudentRosterBulkPanel = "tags" | "status" | "delete";

const STATUS_OPTIONS: { value: StudentRosterStatusFilter | ""; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "trialing", label: "Trial" },
  { value: "inactive", label: "Inactive" },
  { value: "paused", label: "Paused" },
  { value: "canceled", label: "Canceled" },
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
  return (
    <>
      {inactivityThreshold ? (
        <div className="px-8 pt-4">
          <DismissibleNotice tone="warning" onDismiss={onDismissRosterQueryNotice}>
            <div className="text-text-primary">
              <p className="text-sm font-medium text-text-primary">
                Showing students inactive for {inactivityThreshold}+ days
              </p>
              <p className="text-xs text-muted mt-0.5">
                Current holds are excluded automatically from this list.
              </p>
            </div>
          </DismissibleNotice>
        </div>
      ) : null}

      {hasNewStudentFilter && newStudentStartDate ? (
        <div className="px-8 pt-4">
          <DismissibleNotice tone="success" onDismiss={onDismissRosterQueryNotice}>
            <div className="text-text-primary">
              <p className="text-sm font-medium text-text-primary">
                {isNewStudentYtd
                  ? "Showing new students year to date"
                  : `Showing new students from the last ${newStudentDays} days`}
              </p>
              <p className="text-xs text-muted mt-0.5">
                Current active, trialing, or paused students are filtered by membership start date.
              </p>
            </div>
          </DismissibleNotice>
        </div>
      ) : null}

      {fullRosterRequested ? (
        <div className="px-8 pt-4">
          <DismissibleNotice tone="warning" onDismiss={onDismissRosterQueryNotice}>
            <div className="text-text-primary">
              <p className="text-sm font-medium text-text-primary">
                Loading the full roster for dashboard details
              </p>
              <p className="mt-0.5 text-xs text-muted">
                Koaryu is refreshing complete student data so retention and churn details are not based on the bootstrap sample.
              </p>
            </div>
          </DismissibleNotice>
        </div>
      ) : null}

      {actionMessage ? (
        <div className="px-8 pt-4">
          <DismissibleNotice tone="success" onDismiss={onDismissActionMessage}>
            {actionMessage}
          </DismissibleNotice>
        </div>
      ) : null}
    </>
  );
}

export function StudentRosterToolbar({
  activeBulkPanel,
  canManageRoster,
  isRosterRefreshing,
  onProgramFilterChange,
  onSearchChange,
  onStatusFilterChange,
  onToggleBulkPanel,
  programFilter,
  programs,
  search,
  selectedCount,
  statusFilter,
}: {
  activeBulkPanel: StudentRosterBulkPanel | null;
  canManageRoster: boolean;
  isRosterRefreshing: boolean;
  onProgramFilterChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: StudentRosterStatusFilter | "") => void;
  onToggleBulkPanel: (panel: StudentRosterBulkPanel) => void;
  programFilter: string;
  programs: Program[];
  search: string;
  selectedCount: number;
  statusFilter: StudentRosterStatusFilter | "";
}) {
  return (
    <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
      <div className="relative flex-1 max-w-xs">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
        <input
          type="text"
          aria-label="Search students"
          placeholder="Search students..."
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          className="w-full pl-9 pr-3 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </div>

      <select
        aria-label="Filter by status"
        value={statusFilter}
        onChange={(event) => onStatusFilterChange(event.target.value as StudentRosterStatusFilter | "")}
        className="px-3 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
      >
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by program"
        value={programFilter}
        onChange={(event) => onProgramFilterChange(event.target.value)}
        className="px-3 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
      >
        <option value="">All programs</option>
        {programs.filter((program) => !program.archived_at).map((program) => (
          <option key={program.id} value={program.id}>
            {program.name}
          </option>
        ))}
      </select>

      {isRosterRefreshing ? (
        <span className="text-xs text-muted">Updating roster…</span>
      ) : null}

      {canManageRoster && selectedCount > 0 ? (
        <div className="flex items-center gap-2 ml-auto px-3 py-1.5 bg-surface-raised border border-border rounded-[6px]">
          <span className="text-xs text-text-secondary">
            {selectedCount} selected
          </span>
          <span className="text-border">|</span>
          <button
            type="button"
            onClick={() => onToggleBulkPanel("tags")}
            className={`text-xs cursor-pointer ${
              activeBulkPanel === "tags"
                ? "text-accent"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Add tag
          </button>
          <button
            type="button"
            onClick={() => onToggleBulkPanel("status")}
            className={`text-xs cursor-pointer ${
              activeBulkPanel === "status"
                ? "text-accent"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Change status
          </button>
          <button
            type="button"
            onClick={() => onToggleBulkPanel("delete")}
            className="text-xs text-danger hover:text-danger/80 cursor-pointer"
          >
            Delete
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
  if (activeBulkPanel === "tags" && selectedCount > 0) {
    return (
      <div className="px-8 pt-4">
        <div className="rounded-[6px] border border-accent/20 bg-accent/5 px-4 py-3">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary">
                Add tags to {selectedCount} selected {selectedCount === 1 ? "student" : "students"}
              </p>
              <p className="text-xs text-muted mt-1">
                Enter one or more comma-separated tags. Existing tags stay in place and duplicates are ignored.
              </p>
              <div className="mt-3 max-w-xl">
                <Input
                  label="Tags to add"
                  placeholder="vip, leadership, needs-follow-up"
                  value={tagInput}
                  onChange={(event) => onTagInputChange(event.target.value)}
                  disabled={isAddingTags}
                  error={bulkActionError || undefined}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancelTags}
                disabled={isAddingTags}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                isLoading={isAddingTags}
                onClick={onAddTags}
              >
                Add tag
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (activeBulkPanel === "status" && selectedCount > 0) {
    return (
      <div className="px-8 pt-4">
        <div className="rounded-[6px] border border-accent/20 bg-accent/5 px-4 py-3">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary">
                Change status for {selectedCount} selected {selectedCount === 1 ? "student" : "students"}
              </p>
              <p className="text-xs text-muted mt-1">
                This updates the membership status for every selected student at once.
              </p>
              <div className="mt-3 max-w-xs">
                <label className="text-sm text-text-secondary font-medium" htmlFor="bulk-status">
                  New status
                </label>
                <select
                  id="bulk-status"
                  value={bulkStatus}
                  onChange={(event) => onBulkStatusChange(event.target.value as StudentStatus)}
                  disabled={isUpdatingStatus}
                  className="mt-1 w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {STATUS_OPTIONS.filter((option) => option.value).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {bulkActionError ? (
                  <p className="text-xs text-danger mt-2">{bulkActionError}</p>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancelStatus}
                disabled={isUpdatingStatus}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                isLoading={isUpdatingStatus}
                onClick={onBulkStatusUpdate}
              >
                Change status
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if ((activeBulkPanel === "delete" || deleteError) && selectedCount > 0) {
    return (
      <div className="px-8 pt-4">
        <div className="rounded-[6px] border border-danger/20 bg-danger/5 px-4 py-3">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0" />
                <p className="text-sm font-medium text-text-primary">
                  Delete {selectedCount} selected {selectedCount === 1 ? "student" : "students"}?
                </p>
              </div>
              <p className="text-xs text-muted mt-1">
                This removes the selected students from the active roster and cannot be undone from the UI.
              </p>
              {deleteError ? (
                <p className="text-xs text-danger mt-2">{deleteError}</p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancelDelete}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                isLoading={isDeleting}
                onClick={onDeleteSelected}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
