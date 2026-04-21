"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/students/status-badge";
import { StudentForm } from "@/components/students/student-form";
import { useStore } from "@/lib/store";
import type { Student, StudentStatus, StudentCreate } from "@/types";
import {
  UserPlus,
  Upload,
  Search,
  ChevronUp,
  ChevronDown,
  User,
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
  const store = useStore();
  const students = store.students;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  // ---- Filter & Sort ----
  const filtered = useMemo(() => {
    let list = [...students];

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.legal_first_name.toLowerCase().includes(q) ||
          s.legal_last_name.toLowerCase().includes(q) ||
          (s.preferred_name?.toLowerCase() || "").includes(q) ||
          (s.email?.toLowerCase() || "").includes(q)
      );
    }

    if (statusFilter) {
      list = list.filter((s) => s.status === statusFilter);
    }

    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") {
        cmp = displayName(a).localeCompare(displayName(b));
      } else if (sortKey === "status") {
        cmp = a.status.localeCompare(b.status);
      } else if (sortKey === "membership_start_date") {
        cmp =
          (a.membership_start_date || "").localeCompare(
            b.membership_start_date || ""
          );
      } else if (sortKey === "created_at") {
        cmp = a.created_at.localeCompare(b.created_at);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return list;
  }, [students, search, statusFilter, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((s) => s.id)));
    }
  }

  async function handleAddStudent(data: StudentCreate) {
    setIsAdding(true);
    store.addStudent(data);
    setIsAdding(false);
    setShowForm(false);
  }

  const allSelected =
    filtered.length > 0 && selectedIds.size === filtered.length;

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

          {/* Bulk action bar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 ml-auto px-3 py-1.5 bg-surface-raised border border-border rounded-[6px]">
              <span className="text-xs text-text-secondary">
                {selectedIds.size} selected
              </span>
              <span className="text-border">|</span>
              <button className="text-xs text-text-secondary hover:text-text-primary cursor-pointer">
                Add tag
              </button>
              <button className="text-xs text-text-secondary hover:text-text-primary cursor-pointer">
                Change status
              </button>
              <button className="text-xs text-danger hover:text-danger/80 cursor-pointer">
                Delete
              </button>
            </div>
          )}
        </div>

        {/* Table */}
        <div className="overflow-x-auto flex-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <User className="w-8 h-8 text-muted mb-3" />
              <p className="text-sm text-text-secondary">
                {search || statusFilter
                  ? "No students match your filters."
                  : "No students yet. Add your first student to get started."}
              </p>
              {!search && !statusFilter && (
                <button
                  onClick={() => setShowForm(true)}
                  className="mt-3 text-sm text-accent hover:text-accent-hover cursor-pointer"
                >
                  Add student
                </button>
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
                </tr>
              </thead>
              <tbody>
                {filtered.map((student, idx) => {
                  const isSelected = selectedIds.has(student.id);
                  const contact =
                    student.email ||
                    student.phone ||
                    (student.is_minor && student.guardians[0]?.email) ||
                    "—";
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
                      <td className="px-4 py-3 text-text-secondary font-mono text-xs">
                        {contact}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {student.tags.slice(0, 2).map((tag) => (
                            <span
                              key={tag}
                              className="px-1.5 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary"
                            >
                              {tag}
                            </span>
                          ))}
                          {student.tags.length > 2 && (
                            <span className="text-xs text-muted">
                              +{student.tags.length - 2}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-text-secondary font-mono text-xs">
                        {formatDate(student.membership_start_date)}
                      </td>
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
