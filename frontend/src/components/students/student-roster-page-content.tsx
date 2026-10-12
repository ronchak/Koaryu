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
  StudentRosterTable,
} from "@/components/students/student-roster-sections";
import { Button } from "@/components/ui/button";
import { HorizonPage } from "@/components/ui/horizon";
import type { StudentRosterStatusFilter } from "@/lib/student-list-page";
import type { SortDir, SortKey, StudentRosterRow } from "@/lib/students-page-model";
import type { BeltRank, Program, StudentCreate, StudentStatus } from "@/types";
import { Upload, UserPlus } from "lucide-react";
import styles from "./student-records.module.css";

const StudentForm = dynamic(
  () => import("@/components/students/student-form").then((mod) => mod.StudentForm),
  {
    loading: () => <StudentFormLoading />,
    ssr: false,
  },
);

const ROSTER_PLACEHOLDER_ROWS = 12;

function studentsLabel(count: number) {
  return `${count} ${count === 1 ? "student" : "students"}`;
}

type StudentRosterPageContentProps = {
  actionMessage: string | null;
  activeBulkPanel: StudentRosterBulkPanel | null;
  activeLoadError: string | null;
  allSelected: boolean;
  /** Loaded belt ranks, used only to name a rank a roster row knows by id. */
  beltRanks?: readonly BeltRank[];
  bulkActionError: string | null;
  bulkStatus: StudentStatus;
  canCreateStudents: boolean;
  canManageRoster: boolean;
  deleteError: string | null;
  filtered: StudentRosterRow[];
  fullRosterRequested: boolean;
  hasActiveFilters: boolean;
  hasNextPage: boolean;
  hasNewStudentFilter: boolean;
  hasPreviousPage: boolean;
  inactivityByStudentId: ReadonlyMap<string, string>;
  inactivityThreshold: number | null;
  isAdding: boolean;
  isAddingTags: boolean;
  isBulkCommandPending: boolean;
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
  onPrefetchStudent: (studentId: string) => void;
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
  beltRanks,
  bulkActionError,
  bulkStatus,
  canCreateStudents,
  canManageRoster,
  deleteError,
  filtered,
  fullRosterRequested,
  hasActiveFilters,
  hasNextPage,
  hasNewStudentFilter,
  hasPreviousPage,
  inactivityByStudentId,
  inactivityThreshold,
  isAdding,
  isAddingTags,
  isBulkCommandPending,
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
  onPrefetchStudent,
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
    <div className={`flex min-h-full flex-col ${styles.rosterPrintRoot}`}>
      <Header
        title="Students"
        description={
          isInitialRosterLoading ? (
            <span
              aria-hidden="true"
              className="koaryu-skeleton-reveal inline-block h-3 w-20 rounded-full bg-surface-raised align-middle"
            />
          ) : hasActiveFilters ? (
            `${studentsLabel(visibleTotal)} in this view.`
          ) : (
            `${studentsLabel(visibleTotal)} on the roster.`
          )
        }
      >
        {canManageRoster ? (
          <Button variant="secondary" onClick={onImportCsv}>
            <Upload aria-hidden="true" className="w-4 h-4" />
            Import CSV
          </Button>
        ) : null}
        {canCreateStudents ? (
          <Button variant="primary" onClick={onAddStudent}>
            <UserPlus aria-hidden="true" className="w-4 h-4" />
            Add student
          </Button>
        ) : null}
      </Header>

      <HorizonPage className={`flex-1 ${styles.rosterWorkspace}`}>
        {/* One paper sheet on the header's ridge; its glass toolbar is the sheet's head. */}
        <section className={styles.rosterSheet} aria-label="Student roster">
          <StudentRosterToolbar
            activeBulkPanel={activeBulkPanel}
            allSelected={allSelected}
            canManageRoster={canManageRoster}
            hasActiveFilters={hasActiveFilters}
            hasNewStudentFilter={hasNewStudentFilter}
            inactivityThreshold={inactivityThreshold}
            isBulkCommandPending={isBulkCommandPending}
            isNewStudentYtd={isNewStudentYtd}
            isRosterRefreshing={isRosterRefreshing}
            newStudentDays={newStudentDays}
            onClearFilters={onClearFilters}
            onProgramFilterChange={onProgramFilterChange}
            onSearchChange={onSearchChange}
            onSort={onSort}
            onStatusFilterChange={onStatusFilterChange}
            onToggleBulkPanel={onToggleBulkPanel}
            onToggleSelectAll={onToggleSelectAll}
            programFilter={programFilter}
            programs={programs}
            search={search}
            selectedCount={selectedCount}
            sortDir={sortDir}
            sortKey={sortKey}
            statusFilter={statusFilter}
          />

          <div className={styles.rosterSheetBody}>
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

            {canManageRoster ? (
              <StudentRosterBulkActionPanels
                activeBulkPanel={activeBulkPanel}
                bulkActionError={bulkActionError}
                bulkStatus={bulkStatus}
                deleteError={deleteError}
                isAddingTags={isAddingTags}
                isBulkCommandPending={isBulkCommandPending}
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
            ) : null}

            <div className={styles.rosterViewport}>
              {activeLoadError ? (
                <StudentRosterLoadError
                  activeLoadError={activeLoadError}
                  onRetry={onRetryRosterLoad}
                />
              ) : !isInitialRosterLoading && filtered.length === 0 ? (
                <StudentRosterEmptyState
                  canCreateStudents={canCreateStudents}
                  canManageRoster={canManageRoster}
                  hasActiveFilters={hasActiveFilters}
                  onAddStudent={onAddStudent}
                  onClearFilters={onClearFilters}
                  onImportCsv={onImportCsv}
                />
              ) : (
                // A cold load draws placeholder rows inside the same table, so its
                // columns do not move when rows land.
                <div
                  className={styles.rosterLedger}
                  aria-busy={isInitialRosterLoading || undefined}
                >
                  {isInitialRosterLoading ? (
                    <p className="sr-only" role="status">
                      Loading roster
                    </p>
                  ) : null}
                  <StudentRosterTable
                    allSelected={allSelected}
                    beltRanks={beltRanks}
                    canManageRoster={canManageRoster}
                    filtered={isInitialRosterLoading ? [] : filtered}
                    handleSort={onSort}
                    inactivityByStudentId={inactivityByStudentId}
                    inactivityThreshold={inactivityThreshold}
                    isBulkCommandPending={isBulkCommandPending}
                    onOpenStudent={onOpenStudent}
                    onPrefetchStudent={onPrefetchStudent}
                    placeholderRows={isInitialRosterLoading ? ROSTER_PLACEHOLDER_ROWS : 0}
                    programs={programs}
                    selectedIds={selectedIds}
                    sortDir={sortDir}
                    sortKey={sortKey}
                    toggleSelect={onToggleSelect}
                    toggleSelectAll={onToggleSelectAll}
                  />
                </div>
              )}
            </div>

            <StudentRosterFooter
              filteredCount={filtered.length}
              isBulkCommandPending={isBulkCommandPending}
              isPagedLoading={isPagedLoading}
              onNextPage={onNextPage}
              onPreviousPage={onPreviousPage}
              page={page}
              pageEnd={pageEnd}
              pageStart={pageStart}
              pagedTotal={pagedTotal}
              hasNextPage={hasNextPage}
              hasPreviousPage={hasPreviousPage}
              studentsCount={studentsCount}
              totalPages={totalPages}
              usesDerivedRosterFilters={usesDerivedRosterFilters}
            />
          </div>
        </section>
      </HorizonPage>

      {showForm && canCreateStudents ? (
        <StudentForm
          onSubmit={onAddStudentSubmit}
          onClose={onCloseStudentForm}
          isLoading={isAdding}
        />
      ) : null}
    </div>
  );
}
