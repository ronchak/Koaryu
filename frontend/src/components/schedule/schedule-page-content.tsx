"use client";

import dynamic from "next/dynamic";
import { SchedulePageSection } from "@/components/schedule/schedule-page-section";
import { OperationsSurface } from "@/components/operations/operations-surface";
import type { SchedulePageController } from "@/lib/schedule-page-controller";

type SchedulePageContentProps = SchedulePageController["contentProps"];
const ClassFormModal = dynamic(() => import("@/components/schedule/class-form-modal").then(module => module.ClassFormModal), {
  loading: () => <p role="status" className="fixed bottom-4 right-4 z-50 rounded-lg border border-border bg-surface p-4 text-sm">Opening class form…</p>,
});
const ScheduleSessionDetailModal = dynamic(() => import("@/components/schedule/session-detail-modal").then(module => module.ScheduleSessionDetailModal), {
  loading: () => <p role="status" className="fixed bottom-4 right-4 z-50 rounded-lg border border-border bg-surface p-4 text-sm">Opening attendance…</p>,
});

export function SchedulePageContent({
  actionMessage,
  activeStudents,
  attendanceError,
  businessDate,
  canManageSchedule,
  classFormInitialValues,
  createClassError,
  currentDate,
  deleteError,
  deleteInFlight,
  isCreatingClass,
  isRefreshingStudentRoster,
  isSelectedSessionAttendanceReady,
  pendingAttendanceIds,
  programFilter,
  programs,
  scheduleLoadError,
  hasLoadedRange,
  isRefreshingRange,
  selectedSession,
  selectedSessionAttendance,
  studentRosterLoadError,
  isStudentRosterComplete,
  sessions,
  showAddClass,
  templates,
  view,
  onCloseAddClass,
  onCloseSelectedSession,
  onCreateClass,
  onDeleteSelectedSeries,
  onDeleteSelectedSession,
  onDismissActionMessage,
  onDismissAttendanceError,
  onDismissCreateClassError,
  onDismissScheduleLoadError,
  onDismissStudentRosterLoadError,
  onJumpToToday,
  onNavigate,
  onOpenAddClass,
  onOpenSession,
  onRetryRange,
  onProgramFilterChange,
  onSelectDate,
  onToggleAttendance,
  onViewChange,
}: SchedulePageContentProps) {
  return (
    <OperationsSurface page="schedule">
      <SchedulePageSection
        businessDate={businessDate}
        canManageSchedule={canManageSchedule}
        currentDate={currentDate}
        view={view}
        programFilter={programFilter}
        sessions={sessions}
        templates={templates}
        programs={programs}
        scheduleLoadError={scheduleLoadError}
        hasLoadedRange={hasLoadedRange}
        isRefreshingRange={isRefreshingRange}
        actionMessage={actionMessage}
        onNavigate={onNavigate}
        onJumpToToday={onJumpToToday}
        onViewChange={onViewChange}
        onProgramFilterChange={onProgramFilterChange}
        onDismissScheduleLoadError={onDismissScheduleLoadError}
        onDismissActionMessage={onDismissActionMessage}
        onSelectDate={onSelectDate}
        onOpenSession={onOpenSession}
        onRetryRange={onRetryRange}
        onOpenAddClass={onOpenAddClass}
      />

      {selectedSession && <ScheduleSessionDetailModal
        canManageSchedule={canManageSchedule}
        open={Boolean(selectedSession)}
        session={selectedSession}
        students={activeStudents}
        programs={programs}
        attendance={selectedSessionAttendance}
        attendanceError={attendanceError}
        onDismissAttendanceError={onDismissAttendanceError}
        studentRosterError={studentRosterLoadError}
        onDismissStudentRosterError={onDismissStudentRosterLoadError}
        isLoadingStudentRoster={isRefreshingStudentRoster}
        isAttendanceReady={isSelectedSessionAttendanceReady}
        isStudentRosterComplete={isStudentRosterComplete}
        pendingAttendanceStudentIds={pendingAttendanceIds}
        deleteError={deleteError}
        deleteInFlight={deleteInFlight}
        onClose={onCloseSelectedSession}
        onToggleAttendance={onToggleAttendance}
        onDeleteSession={onDeleteSelectedSession}
        onDeleteSeries={onDeleteSelectedSeries}
      />}

      {showAddClass && <ClassFormModal
        allowRecurring={canManageSchedule}
        open={showAddClass}
        onClose={onCloseAddClass}
        isLoading={isCreatingClass}
        error={createClassError}
        onDismissError={onDismissCreateClassError}
        title="Add class"
        defaultMode={canManageSchedule ? "weekly" : "single"}
        programs={programs}
        initialValues={classFormInitialValues}
        onSubmit={onCreateClass}
      />}
    </OperationsSurface>
  );
}
