"use client";

import { ClassFormModal } from "@/components/schedule/class-form-modal";
import { SchedulePageSection } from "@/components/schedule/schedule-page-section";
import { ScheduleSessionDetailModal } from "@/components/schedule/session-detail-modal";
import type { SchedulePageController } from "@/lib/schedule-page-controller";

type SchedulePageContentProps = SchedulePageController["contentProps"];

export function SchedulePageContent({
  actionMessage,
  activeStudents,
  attendanceError,
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
  selectedSession,
  selectedSessionAttendance,
  studentRosterLoadError,
  studentsMayBePartial,
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
  onProgramFilterChange,
  onSelectDate,
  onToggleAttendance,
  onViewChange,
}: SchedulePageContentProps) {
  return (
    <>
      <SchedulePageSection
        currentDate={currentDate}
        view={view}
        programFilter={programFilter}
        sessions={sessions}
        templates={templates}
        programs={programs}
        scheduleLoadError={scheduleLoadError}
        actionMessage={actionMessage}
        onNavigate={onNavigate}
        onJumpToToday={onJumpToToday}
        onViewChange={onViewChange}
        onProgramFilterChange={onProgramFilterChange}
        onDismissScheduleLoadError={onDismissScheduleLoadError}
        onDismissActionMessage={onDismissActionMessage}
        onSelectDate={onSelectDate}
        onOpenSession={onOpenSession}
        onOpenAddClass={onOpenAddClass}
      />

      <ScheduleSessionDetailModal
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
        isStudentRosterComplete={!studentsMayBePartial}
        pendingAttendanceStudentIds={pendingAttendanceIds}
        deleteError={deleteError}
        deleteInFlight={deleteInFlight}
        onClose={onCloseSelectedSession}
        onToggleAttendance={onToggleAttendance}
        onDeleteSession={onDeleteSelectedSession}
        onDeleteSeries={onDeleteSelectedSeries}
      />

      <ClassFormModal
        open={showAddClass}
        onClose={onCloseAddClass}
        isLoading={isCreatingClass}
        error={createClassError}
        onDismissError={onDismissCreateClassError}
        title="Add class"
        defaultMode="weekly"
        programs={programs}
        onSubmit={onCreateClass}
      />
    </>
  );
}
