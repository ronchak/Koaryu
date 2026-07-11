"use client";

import dynamic from "next/dynamic";
import { Header } from "@/components/header";
import {
  StudentRosterBulkActionPanels,
  StudentRosterNotices,
  StudentRosterToolbar,
  type StudentRosterBulkPanel,
} from "@/components/students/student-roster-controls";
import {
  StudentFormLoading,
  StudentRosterEmptyState,
  StudentRosterFooter,
  StudentRosterLoadError,
  StudentRosterLoading,
  StudentRosterTable,
} from "@/components/students/student-roster-sections";
import { Button } from "@/components/ui/button";
import type { StudentRosterStatusFilter } from "@/lib/student-list-page";
import type { SortDir, SortKey, StudentRosterRow } from "@/lib/students-page-model";
import type { Program, StudentCreate, StudentStatus } from "@/types";
import { Upload, UserPlus } from "lucide-react";

const StudentForm = dynamic(
  () => import("@/components/students/student-form").then((mod) => mod.StudentForm),
  {
    loading: () => <StudentFormLoading />,
    ssr: false,
  }
);

type StudentRosterPageContentProps = {
  actionMessage: string | null;
  activeBulkPanel: StudentRosterBulkPanel | null;
  activeLoadError: string | null;
  allSelected: boolean;
  bulkActionError: string | null;
  bulkStatus: StudentStatus;
  deleteError: string | null;
  filtered: StudentRosterRow[];
  fullRosterRequested: boolean;
  hasActiveFilters: boolean;
  hasNewStudentFilter: boolean;
  inactivityByStudentId: ReadonlyMap<string, string>;
  inactivityThreshold: number | null;
  isAdding: boolean;
  isAddingTags: boolean;
  isDeleting: boolean;
  isInitialRosterLoading: boolean;
  isNewStudentYtd: boolean;
  isPagedLoading: boolean;
  isRosterRefreshing: boolean;
  isUpdatingStatus: boolean;
  newStudentDays: number | null;
  newStudentStartDate: string | null;
  onAddStudent: () => void;
  onAddStudentSubmit: (data: StudentCreate) => Promise<void>;
  onAddTags: () => Promise<void>;
  onBulkStatusChange: (status: StudentStatus) => void;
  onBulkStatusUpdate: () => Promise<void>;
  onCancelDelete: () => void;
  onCancelStatus: () => void;
  onCancelTags: () => void;
  onClearFilters: () => void;
  onCloseStudentForm: () => void;
  onDeleteSelected: () => Promise<void>;
  onDismissActionMessage: () => void;
  onDismissRosterQueryNotice: () => void;
  onImportCsv: () => void;
  onNextPage: () => void;
  onOpenStudent: (studentId: string) => void;
  onPreviousPage: () => void;
  onProgramFilterChange: (value: string) => void;
  onRetryRosterLoad: () => void;
  onSearchChange: (value: string) => void;
  onSort: (key: SortKey) => void;
  onStatusFilterChange: (value: StudentRosterStatusFilter | "") => void;
  onTagInputChange: (value: string) => void;
  onToggleBulkPanel: (panel: StudentRosterBulkPanel) => void;
  onToggleSelect: (studentId: string) => void;
  onToggleSelectAll: () => void;
  page: number;
  pageEnd: number;
  pageStart: number;
  pagedTotal: number;
  programFilter: string;
  programs: Program[];
  search: string;
  selectedCount: number;
  selectedIds: Set<string>;
  showForm: boolean;
  sortDir: SortDir;
  sortKey: SortKey;
  statusFilter: StudentRosterStatusFilter | "";
  studentsCount: number;
  tagInput: string;
  totalPages: number;
  usesDerivedRosterFilters: boolean;
  visibleTotal: number;
};

export function StudentRosterPageContent({
  actionMessage,
  activeBulkPanel,
  activeLoadError,
  allSelected,
  bulkActionError,
  bulkStatus,
  deleteError,
  filtered,
  fullRosterRequested,
  hasActiveFilters,
  hasNewStudentFilter,
  inactivityByStudentId,
  inactivityThreshold,
  isAdding,
  isAddingTags,
  isDeleting,
  isInitialRosterLoading,
  isNewStudentYtd,
  isPagedLoading,
  isRosterRefreshing,
  isUpdatingStatus,
  newStudentDays,
  newStudentStartDate,
  onAddStudent,
  onAddStudentSubmit,
  onAddTags,
  onBulkStatusChange,
  onBulkStatusUpdate,
  onCancelDelete,
  onCancelStatus,
  onCancelTags,
  onClearFilters,
  onCloseStudentForm,
  onDeleteSelected,
  onDismissActionMessage,
  onDismissRosterQueryNotice,
  onImportCsv,
  onNextPage,
  onOpenStudent,
  onPreviousPage,
  onProgramFilterChange,
  onRetryRosterLoad,
  onSearchChange,
  onSort,
  onStatusFilterChange,
  onTagInputChange,
  onToggleBulkPanel,
  onToggleSelect,
  onToggleSelectAll,
  page,
  pageEnd,
  pageStart,
  pagedTotal,
  programFilter,
  programs,
  search,
  selectedCount,
  selectedIds,
  showForm,
  sortDir,
  sortKey,
  statusFilter,
  studentsCount,
  tagInput,
  totalPages,
  usesDerivedRosterFilters,
  visibleTotal,
}: StudentRosterPageContentProps) {
  return (
    <>
      <Header
        title="Students"
        description={
          isInitialRosterLoading
            ? "Loading roster"
            : `${visibleTotal} ${visibleTotal === 1 ? "student" : "students"}`
        }
      >
        <Button variant="secondary" size="sm" onClick={onImportCsv}>
          <Upload className="w-3.5 h-3.5" />
          Import CSV
        </Button>
        <Button variant="primary" size="sm" onClick={onAddStudent}>
          <UserPlus className="w-3.5 h-3.5" />
          Add student
        </Button>
      </Header>

      <div className="flex-1 flex flex-col">
        <StudentRosterNotices
          actionMessage={actionMessage}
          fullRosterRequested={fullRosterRequested}
          hasNewStudentFilter={hasNewStudentFilter}
          inactivityThreshold={inactivityThreshold}
          isNewStudentYtd={isNewStudentYtd}
          newStudentDays={newStudentDays}
          newStudentStartDate={newStudentStartDate}
          onDismissActionMessage={onDismissActionMessage}
          onDismissRosterQueryNotice={onDismissRosterQueryNotice}
        />

        <StudentRosterToolbar
          activeBulkPanel={activeBulkPanel}
          isRosterRefreshing={isRosterRefreshing}
          onProgramFilterChange={onProgramFilterChange}
          onSearchChange={onSearchChange}
          onStatusFilterChange={onStatusFilterChange}
          onToggleBulkPanel={onToggleBulkPanel}
          programFilter={programFilter}
          programs={programs}
          search={search}
          selectedCount={selectedCount}
          statusFilter={statusFilter}
        />

        <StudentRosterBulkActionPanels
          activeBulkPanel={activeBulkPanel}
          bulkActionError={bulkActionError}
          bulkStatus={bulkStatus}
          deleteError={deleteError}
          isAddingTags={isAddingTags}
          isDeleting={isDeleting}
          isUpdatingStatus={isUpdatingStatus}
          onAddTags={onAddTags}
          onBulkStatusChange={onBulkStatusChange}
          onBulkStatusUpdate={onBulkStatusUpdate}
          onCancelDelete={onCancelDelete}
          onCancelStatus={onCancelStatus}
          onCancelTags={onCancelTags}
          onDeleteSelected={onDeleteSelected}
          onTagInputChange={onTagInputChange}
          selectedCount={selectedCount}
          tagInput={tagInput}
        />

        <div className="overflow-x-auto flex-1">
          {activeLoadError ? (
            <StudentRosterLoadError
              activeLoadError={activeLoadError}
              onRetry={onRetryRosterLoad}
            />
          ) : isInitialRosterLoading ? (
            <StudentRosterLoading />
          ) : filtered.length === 0 ? (
            <StudentRosterEmptyState
              hasActiveFilters={hasActiveFilters}
              onAddStudent={onAddStudent}
              onClearFilters={onClearFilters}
              onImportCsv={onImportCsv}
            />
          ) : (
            <StudentRosterTable
              allSelected={allSelected}
              filtered={filtered}
              handleSort={onSort}
              inactivityByStudentId={inactivityByStudentId}
              inactivityThreshold={inactivityThreshold}
              onOpenStudent={onOpenStudent}
              programs={programs}
              selectedIds={selectedIds}
              sortDir={sortDir}
              sortKey={sortKey}
              toggleSelect={onToggleSelect}
              toggleSelectAll={onToggleSelectAll}
            />
          )}
        </div>

        <StudentRosterFooter
          filteredCount={filtered.length}
          isPagedLoading={isPagedLoading}
          onNextPage={onNextPage}
          onPreviousPage={onPreviousPage}
          page={page}
          pageEnd={pageEnd}
          pageStart={pageStart}
          pagedTotal={pagedTotal}
          studentsCount={studentsCount}
          totalPages={totalPages}
          usesDerivedRosterFilters={usesDerivedRosterFilters}
        />
      </div>

      {showForm ? (
        <StudentForm
          onSubmit={onAddStudentSubmit}
          onClose={onCloseStudentForm}
          isLoading={isAdding}
        />
      ) : null}
    </>
  );
}
