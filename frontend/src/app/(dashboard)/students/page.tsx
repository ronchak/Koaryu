"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/students/status-badge";
import { StudentForm } from "@/components/students/student-form";
import { buildStudentInactivityRows } from "@/lib/student-insights";
import { useProgramStore, useScheduleStore, useStudentStore } from "@/lib/store";
import { ProgramBadge } from "@/components/programs/program-picker";
import type { Student, StudentCreate, StudentStatus } from "@/types";
import {
  UserPlus,
  Upload,
  Search,
  ChevronUp,
  ChevronDown,
  User,
  AlertTriangle,
  Trash2,
} from "lucide-react";

type SortKey = "name" | "status" | "membership_start_date" | "created_at";
type SortDir = "asc" | "desc";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "trialing", label: "Trial" },
  { value: "inactive", label: "Inactive" },
  { value: "paused", label: "Paused" },
  { value: "canceled", label: "Canceled" },
];
const STUDENTS_BOOTSTRAP_FRESH_MS = 30_000;

function formatDate(d?: string) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function displayName(s: Student) {
  return `${s.legal_last_name}, ${s.preferred_name || s.legal_first_name}`;
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
  if (sortKey !== col)
    return <ChevronUp className="w-3 h-3 opacity-20" />;
  return sortDir === "asc" ? (
    <ChevronUp className="w-3 h-3 text-accent" />
  ) : (
    <ChevronDown className="w-3 h-3 text-accent" />
  );
}

export default function StudentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    students,
    studentsLoaded,
    studentsLoadError,
    studentsLastLoadedAt,
    studentsMayBePartial,
    addStudent,
    bulkAddTagsToStudents,
    bulkUpdateStudentStatus,
    deleteStudents,
    refreshStudents,
  } = useStudentStore();
  const { sessions, attendance } = useScheduleStore();
  const { programs } = useProgramStore();
  const inactivityThreshold = Number(searchParams.get("inactiveDays") || "") || null;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [programFilter, setProgramFilter] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [activeBulkPanel, setActiveBulkPanel] = useState<"tags" | "status" | "delete" | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAddingTags, setIsAddingTags] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [bulkActionError, setBulkActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [bulkStatus, setBulkStatus] = useState<StudentStatus>("active");
  const studentRows = useMemo(
    () =>
      students.map((student) => ({
        student,
        displayName: displayName(student),
        programs: (student.program_memberships || [])
          .filter((membership) => membership.status !== "ended" && !membership.ended_at)
          .map((membership) => programs.find((program) => program.id === membership.program_id))
          .filter(Boolean),
        searchFields: {
          legalFirstName: student.legal_first_name.toLowerCase(),
          legalLastName: student.legal_last_name.toLowerCase(),
          preferredName: student.preferred_name?.toLowerCase() || "",
          email: student.email?.toLowerCase() || "",
          programs: (student.program_memberships || [])
            .map((membership) => membership.program_name || "")
            .join(" ")
            .toLowerCase(),
        },
        contact:
          student.email ||
          student.phone ||
          (student.is_minor && student.guardians[0]?.email) ||
          "—",
        visibleTags: student.tags.slice(0, 2),
        hiddenTagCount: Math.max(0, student.tags.length - 2),
      })),
    [programs, students]
  );
  const inactivityRows = useMemo(
    () =>
      inactivityThreshold
        ? buildStudentInactivityRows(students, sessions, attendance)
        : [],
    [attendance, inactivityThreshold, sessions, students]
  );
  const inactivityByStudentId = useMemo(
    () => new Map(inactivityRows.map((row) => [row.student.id, row.daysInactive])),
    [inactivityRows]
  );
  const hasActiveFilters = Boolean(search || statusFilter || programFilter || inactivityThreshold);

  useEffect(() => {
    if (!studentsLoaded) {
      return;
    }

    if (
      !studentsLoadError &&
      !studentsMayBePartial &&
      studentsLastLoadedAt &&
      Date.now() - studentsLastLoadedAt < STUDENTS_BOOTSTRAP_FRESH_MS
    ) {
      return;
    }

    void refreshStudents().catch((error) => {
      console.error("Failed to refresh students page data", error);
    });
  }, [refreshStudents, studentsLastLoadedAt, studentsLoadError, studentsLoaded, studentsMayBePartial]);

  // ---- Filter & Sort ----
  const filtered = useMemo(() => {
    let list = [...studentRows];

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (row) =>
          row.searchFields.legalFirstName.includes(q) ||
          row.searchFields.legalLastName.includes(q) ||
	          row.searchFields.preferredName.includes(q) ||
	          row.searchFields.email.includes(q) ||
	          row.searchFields.programs.includes(q)
	      );
	    }

	    if (statusFilter) {
	      list = list.filter((row) => row.student.status === statusFilter);
	    }
	    if (programFilter) {
	      list = list.filter((row) =>
	        (row.student.program_memberships || []).some((membership) =>
	          membership.program_id === programFilter &&
	          membership.status !== "ended" &&
	          !membership.ended_at
	        ) || row.student.program_id === programFilter
	      );
	    }

    if (inactivityThreshold) {
      list = list.filter(
        (row) => (inactivityByStudentId.get(row.student.id) || 0) >= inactivityThreshold
      );
    }

    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") {
        cmp = a.displayName.localeCompare(b.displayName);
      } else if (sortKey === "status") {
        cmp = a.student.status.localeCompare(b.student.status);
      } else if (sortKey === "membership_start_date") {
        cmp =
          (a.student.membership_start_date || "").localeCompare(
            b.student.membership_start_date || ""
          );
      } else if (sortKey === "created_at") {
        cmp = a.student.created_at.localeCompare(b.student.created_at);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return list;
  }, [studentRows, search, statusFilter, programFilter, inactivityThreshold, inactivityByStudentId, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function toggleSelect(id: string) {
    setDeleteError(null);
    setBulkActionError(null);
    setActionMessage(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      if (next.size === 0) {
        setActiveBulkPanel(null);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    setDeleteError(null);
    setBulkActionError(null);
    setActionMessage(null);
    if (selectedIds.size === filtered.length) {
      setActiveBulkPanel(null);
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((row) => row.student.id)));
    }
  }

  function toggleBulkPanel(panel: "tags" | "status" | "delete") {
    setDeleteError(null);
    setBulkActionError(null);
    setActionMessage(null);
    setActiveBulkPanel((current) => (current === panel ? null : panel));
  }

  async function handleDeleteSelected() {
    if (selectedIds.size === 0) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const deleteCount = selectedIds.size;
      await deleteStudents(Array.from(selectedIds));
      setSelectedIds(new Set());
      setActiveBulkPanel(null);
      setActionMessage(`${deleteCount} ${deleteCount === 1 ? "student was" : "students were"} removed from the active roster.`);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Failed to delete selected students.");
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleAddTags() {
    if (selectedIds.size === 0) return;

    const tags = Array.from(
      new Set(
        tagInput
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      )
    );

    if (tags.length === 0) {
      setBulkActionError("Enter at least one tag to add.");
      return;
    }

    setIsAddingTags(true);
    setBulkActionError(null);

    try {
      const result = await bulkAddTagsToStudents(Array.from(selectedIds), tags);
      if (result.updated !== selectedIds.size) {
        setBulkActionError(
          `Added tags to ${result.updated} of ${selectedIds.size} selected students. Some students may no longer be available.`
        );
        return;
      }
      setTagInput("");
      setActiveBulkPanel(null);
      setActionMessage(`Tags added to ${result.updated} ${result.updated === 1 ? "student" : "students"}.`);
    } catch (error) {
      setBulkActionError(error instanceof Error ? error.message : "Failed to add tags.");
    } finally {
      setIsAddingTags(false);
    }
  }

  async function handleBulkStatusUpdate() {
    if (selectedIds.size === 0) return;

    setIsUpdatingStatus(true);
    setBulkActionError(null);

    try {
      const result = await bulkUpdateStudentStatus(Array.from(selectedIds), bulkStatus);
      if (result.updated !== selectedIds.size) {
        setBulkActionError(
          `Updated ${result.updated} of ${selectedIds.size} selected students. Some students may no longer be available.`
        );
        return;
      }
      setActiveBulkPanel(null);
      setActionMessage(`Status changed to ${bulkStatus} for ${result.updated} ${result.updated === 1 ? "student" : "students"}.`);
    } catch (error) {
      setBulkActionError(error instanceof Error ? error.message : "Failed to update status.");
    } finally {
      setIsUpdatingStatus(false);
    }
  }

  async function handleAddStudent(data: StudentCreate) {
    setIsAdding(true);
    try {
      await addStudent(data);
      setShowForm(false);
      setActionMessage("Student added to the roster.");
    } finally {
      setIsAdding(false);
    }
  }

  const allSelected =
    filtered.length > 0 && selectedIds.size === filtered.length;
  const selectedCount = selectedIds.size;

  return (
    <>
      <Header title="Students" description={`${students.length} students`}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => router.push("/students/import")}
        >
          <Upload className="w-3.5 h-3.5" />
          Import CSV
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowForm(true)}
        >
          <UserPlus className="w-3.5 h-3.5" />
          Add student
        </Button>
      </Header>

      <div className="flex-1 flex flex-col">
        {inactivityThreshold && (
          <div className="px-8 pt-4">
            <DismissibleNotice tone="warning" onDismiss={() => router.push("/students")}>
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
        )}

        {actionMessage ? (
          <div className="px-8 pt-4">
            <DismissibleNotice tone="success" onDismiss={() => setActionMessage(null)}>
              {actionMessage}
            </DismissibleNotice>
          </div>
        ) : null}

        {/* Toolbar */}
        <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
          {/* Search */}
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
            <input
              type="text"
              placeholder="Search students..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            value={programFilter}
            onChange={(e) => setProgramFilter(e.target.value)}
            className="px-3 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
          >
            <option value="">All programs</option>
            {programs.filter((program) => !program.archived_at).map((program) => (
              <option key={program.id} value={program.id}>
                {program.name}
              </option>
            ))}
          </select>

          {/* Bulk action bar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 ml-auto px-3 py-1.5 bg-surface-raised border border-border rounded-[6px]">
              <span className="text-xs text-text-secondary">
                {selectedIds.size} selected
              </span>
              <span className="text-border">|</span>
              <button
                type="button"
                onClick={() => toggleBulkPanel("tags")}
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
                onClick={() => toggleBulkPanel("status")}
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
                onClick={() => toggleBulkPanel("delete")}
                className="text-xs text-danger hover:text-danger/80 cursor-pointer"
              >
                Delete
              </button>
            </div>
          )}
        </div>

        {activeBulkPanel === "tags" && selectedCount > 0 ? (
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
                      onChange={(e) => setTagInput(e.target.value)}
                      disabled={isAddingTags}
                      error={bulkActionError || undefined}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setActiveBulkPanel(null);
                      setBulkActionError(null);
                      setTagInput("");
                    }}
                    disabled={isAddingTags}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    isLoading={isAddingTags}
                    onClick={handleAddTags}
                  >
                    Add tag
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {activeBulkPanel === "status" && selectedCount > 0 ? (
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
                      onChange={(e) => setBulkStatus(e.target.value as StudentStatus)}
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
                    onClick={() => {
                      setActiveBulkPanel(null);
                      setBulkActionError(null);
                    }}
                    disabled={isUpdatingStatus}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    isLoading={isUpdatingStatus}
                    onClick={handleBulkStatusUpdate}
                  >
                    Change status
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {(activeBulkPanel === "delete" || deleteError) && selectedCount > 0 ? (
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
                    onClick={() => {
                      setActiveBulkPanel(null);
                      setDeleteError(null);
                    }}
                    disabled={isDeleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    isLoading={isDeleting}
                    onClick={handleDeleteSelected}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Table */}
        <div className="overflow-x-auto flex-1">
          {studentsLoadError ? (
            <div className="flex flex-col items-center justify-center py-20">
              <AlertTriangle className="w-8 h-8 text-danger mb-3" />
              <p className="text-sm text-text-secondary text-center max-w-md">
                Koaryu could not load the student roster right now.
              </p>
              <p className="mt-2 text-xs text-muted text-center max-w-xl break-words">
                {studentsLoadError}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-4"
                onClick={() => {
                  void refreshStudents().catch((error) => {
                    console.error("Failed to retry student roster load", error);
                  });
                }}
              >
                Try again
              </Button>
            </div>
          ) : !studentsLoaded ? (
            <div className="flex flex-col items-center justify-center py-20">
              <p className="text-sm text-text-secondary">Loading students…</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <User className="w-8 h-8 text-muted mb-3" />
              <p className="text-sm text-text-secondary">
                {hasActiveFilters
                  ? "No students match your filters."
                  : "No students yet. Add your first student to get started."}
              </p>
              {hasActiveFilters ? (
                <button
                  onClick={() => {
	                    setSearch("");
	                    setStatusFilter("");
	                    setProgramFilter("");
	                    router.replace("/students");
                  }}
                  className="mt-3 text-sm text-accent hover:text-accent-hover cursor-pointer"
                >
                  Clear filters
                </button>
              ) : (
                <div className="mt-4 flex items-center gap-3">
                  <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                    <UserPlus className="w-3.5 h-3.5" />
                    Add student
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => router.push("/students/import")}>
                    <Upload className="w-3.5 h-3.5" />
                    Import CSV
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="accent-[var(--accent)] cursor-pointer"
                    />
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium text-text-secondary cursor-pointer select-none"
                    onClick={() => handleSort("name")}
                  >
                    <span className="flex items-center gap-1">
                      Name
                      <SortIcon col="name" sortKey={sortKey} sortDir={sortDir} />
                    </span>
                  </th>
	                  <th
	                    className="px-4 py-3 text-left text-xs font-medium text-text-secondary cursor-pointer select-none"
	                    onClick={() => handleSort("status")}
	                  >
                    <span className="flex items-center gap-1">
                      Status
                      <SortIcon col="status" sortKey={sortKey} sortDir={sortDir} />
	                    </span>
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
                    className="px-4 py-3 text-left text-xs font-medium text-text-secondary cursor-pointer select-none"
                    onClick={() => handleSort("membership_start_date")}
                  >
                    <span className="flex items-center gap-1">
                      Member since
                      <SortIcon
                        col="membership_start_date"
                        sortKey={sortKey}
                        sortDir={sortDir}
                      />
                    </span>
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
                  return (
                    <tr
                      key={student.id}
                      onClick={() =>
                        router.push(`/students/${student.id}`)
                      }
                      className={`
                        border-b border-border cursor-pointer
                        transition-colors duration-100
                        ${isSelected ? "bg-accent/5" : idx % 2 === 0 ? "" : "bg-surface/40"}
                        hover:bg-surface-raised
                      `}
                    >
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
                          onChange={() => toggleSelect(student.id)}
                          className="accent-[var(--accent)] cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-full bg-surface-raised border border-border flex items-center justify-center flex-shrink-0">
                            <span className="text-xs font-medium text-text-secondary">
                              {student.legal_first_name[0]}
                              {student.legal_last_name[0]}
                            </span>
                          </div>
                          <div>
                            <p className="font-medium text-text-primary text-sm">
                              {student.preferred_name || student.legal_first_name}{" "}
                              {student.legal_last_name}
                            </p>
                            {student.is_minor && (
                              <p className="text-xs text-muted">Minor</p>
                            )}
                          </div>
                        </div>
                      </td>
	                      <td className="px-4 py-3">
	                        <StatusBadge status={student.status} />
	                      </td>
	                      <td className="px-4 py-3">
	                        <div className="flex flex-wrap gap-1">
	                          {row.programs.length > 0 ? (
	                            row.programs.map((program) => (
	                              <ProgramBadge key={program!.id} program={program} />
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
                          {inactivityByStudentId.get(student.id) || 0}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer count */}
        {filtered.length > 0 && (
          <div className="px-8 py-3 border-t border-border">
            <p className="text-xs text-muted">
              Showing {filtered.length} of {students.length} students
            </p>
          </div>
        )}
      </div>

      {/* Add student modal */}
      {showForm && (
        <StudentForm
          onSubmit={handleAddStudent}
          onClose={() => setShowForm(false)}
          isLoading={isAdding}
        />
      )}
    </>
  );
}
