"use client";

import { Header } from "@/components/header";
import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import {
  StudentDetailSections,
  StudentNextSteps,
  buildStudentNextSteps,
} from "@/components/students/student-detail-sections";
import { StudentDetailSidebar } from "@/components/students/student-detail-sidebar";
import {
  StudentDetailBodySkeleton,
  StudentDetailSkeleton,
} from "@/components/students/student-detail-skeleton";
import { StudentForm } from "@/components/students/student-form";
import { STUDENT_STATUS_DISPLAY } from "@/components/students/student-status";
import { Button } from "@/components/ui/button";
import { CalmState, HorizonPage } from "@/components/ui/horizon";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import type { StudentDetailPageController } from "@/lib/student-detail-page-controller";
import type { Student } from "@/types";
import { AlertTriangle, ArrowLeft, ArrowRight, Pencil, Trash2, UserX } from "lucide-react";
import styles from "./student-records.module.css";

type StudentDetailPageContentProps = StudentDetailPageController["contentProps"];

function formatMonthYear(d?: string | null) {
  if (!d) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** One plain sentence under the name: who this is to the studio right now. */
function describeStudent(student: Student) {
  const since = formatMonthYear(student.membership_start_date);
  const who = student.is_minor ? "student (minor)" : "student";
  switch (student.status) {
    case "active":
      return since ? `Active ${who} since ${since}.` : `Active ${who}.`;
    case "trialing":
      return since ? `Trial ${who} since ${since}.` : `Trial ${who}.`;
    case "paused":
      return since ? `On hold. Member since ${since}.` : "On hold.";
    default:
      return since
        ? `${STUDENT_STATUS_DISPLAY[student.status]?.label ?? "Inactive"}. Member since ${since}.`
        : `${STUDENT_STATUS_DISPLAY[student.status]?.label ?? "Inactive"}.`;
  }
}

export function StudentDetailPageContent({
  actionMessage,
  beltLoadError,
  businessDate,
  canManageRoster,
  canManageStudentLifecycle,
  deleteError,
  detail,
  detailReady,
  recordComplete,
  isDeleting,
  isLoadingBeltData,
  isLoadingStudent,
  isPhotoSaving,
  isSaving,
  isStudentCommandPending,
  loadError,
  photoError,
  photoPreviewUrl,
  programs,
  promotionHistory,
  showDeleteConfirm,
  showEdit,
  student,
  onBackToStudents,
  onCancelDelete,
  onCloseEdit,
  onDeletePhoto,
  onDeleteStudent,
  onDismissActionMessage,
  onEdit,
  onPhotoSelected,
  onRetryDetail,
  onShowDeleteConfirm,
  onShowEdit,
}: StudentDetailPageContentProps) {
  if (isLoadingStudent) {
    return (
      <StudentDetailSkeleton
        canManageRoster={canManageRoster}
        onBackToStudents={onBackToStudents}
      />
    );
  }

  if (!student || !detail) {
    return (
      <div className={`flex min-h-full flex-col ${styles.folioRoot}`}>
        <Header eyebrow="Students" title={loadError ? "Student unavailable" : "Student not found"}>
          <Button variant="ghost" onClick={onBackToStudents}>
            <ArrowLeft aria-hidden="true" className="w-4 h-4" /> Back
          </Button>
        </Header>
        <HorizonPage width="medium">
          <CalmState
            tone={loadError ? "alert" : "neutral"}
            icon={<UserX />}
            title={loadError ? "Koaryu could not load this student." : "No student here."}
            detail={loadError || "This student doesn't exist or has been archived."}
            action={
              loadError ? (
                <Button variant="secondary" size="sm" onClick={onRetryDetail}>
                  Retry student details
                </Button>
              ) : null
            }
          />
        </HorizonPage>
      </div>
    );
  }

  const editDisabled = !detailReady || isStudentCommandPending;
  const nextSteps = buildStudentNextSteps({
    isCurrentHold: detail.isCurrentHold,
    primaryGuardian: detail.primaryGuardian,
    student,
  });

  return (
    <div className={`flex min-h-full flex-col ${styles.folioRoot}`}>
      <Header eyebrow="Student" title={detail.fullName} description={describeStudent(student)}>
        <Button variant="secondary" onClick={onBackToStudents}>
          <ArrowLeft aria-hidden="true" className="w-4 h-4" />
          <span>
            Back<span className="max-sm:sr-only"> to students</span>
          </span>
        </Button>
        {canManageRoster ? (
          <Button variant="secondary" onClick={onShowDeleteConfirm} disabled={editDisabled}>
            <Trash2 aria-hidden="true" className="w-4 h-4" />
            Archive
          </Button>
        ) : null}
        <Button variant="primary" onClick={onShowEdit} disabled={editDisabled}>
          <Pencil aria-hidden="true" className="w-4 h-4" />
          Edit
        </Button>
      </Header>

      <HorizonPage className={`flex-1 ${styles.folioPage}`}>
        {/* A record known from the roster draws in full while its own read settles;
            editing and archiving stay disabled until that read lands. */}
        {!recordComplete ? (
          <StudentDetailBodySkeleton />
        ) : (
          <StudentDetailSidebar
            canManageRoster={canManageRoster}
            student={student}
            fullName={detail.fullName}
            programs={programs}
            activeProgramIds={detail.activeProgramIds}
            photoPreviewUrl={photoPreviewUrl}
            photoError={photoError}
            isPhotoSaving={isPhotoSaving}
            isCommandPending={isStudentCommandPending}
            onPhotoSelected={onPhotoSelected}
            onDeletePhoto={onDeletePhoto}
            isCurrentHold={detail.isCurrentHold}
            currentRank={detail.currentRank}
            nextRank={detail.nextRank}
            latestPromotionAt={detail.latestPromotion?.promoted_at}
            promotionCount={promotionHistory.length}
            isLoadingBeltData={isLoadingBeltData}
            beltLoadError={beltLoadError}
            businessDate={businessDate}
          />
        )}

        {actionMessage ? (
          <DismissibleNotice tone="success" onDismiss={onDismissActionMessage}>
            {actionMessage}
          </DismissibleNotice>
        ) : null}

        {loadError ? (
          <div className={styles.folioNotice} role="status">
            <p>
              {detailReady ? "Showing the last loaded details." : "Showing the roster's copy."}{" "}
              {loadError}
            </p>
            <Button variant="secondary" size="sm" onClick={onRetryDetail}>
              Retry student details
            </Button>
          </div>
        ) : null}

        {canManageRoster && (showDeleteConfirm || deleteError) ? (
          <div className={styles.folioNotice} data-tone="alert">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <AlertTriangle aria-hidden="true" className="w-4 h-4 text-danger flex-shrink-0" />
                <p className="text-sm font-semibold text-text-primary">Archive this student?</p>
              </div>
              <p className="text-[0.8125rem] text-text-secondary mt-1">
                This removes {detail.fullName} from the active roster. Their history is preserved.
              </p>
              {deleteError ? <p className="text-xs text-danger mt-2">{deleteError}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onCancelDelete} disabled={isDeleting}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                isLoading={isDeleting}
                disabled={isStudentCommandPending}
                onClick={onDeleteStudent}
              >
                <Trash2 aria-hidden="true" className="w-3.5 h-3.5" />
                Archive
              </Button>
            </div>
          </div>
        ) : null}

        {recordComplete ? (
          <StudentDetailSections
            student={student}
            primaryGuardian={detail.primaryGuardian}
            currentRank={detail.currentRank}
            promotionHistory={promotionHistory}
            rankById={detail.rankById}
            isCurrentHold={detail.isCurrentHold}
            isLoadingBeltData={isLoadingBeltData}
            beltLoadError={beltLoadError}
            recordActions={
              <Link href="/belt-tracker" className={styles.panelLink}>
                Belt tracker
                <ArrowRight aria-hidden="true" />
              </Link>
            }
            lead={
              <StudentNextSteps steps={nextSteps} onEdit={onShowEdit} editDisabled={editDisabled} />
            }
          />
        ) : null}
      </HorizonPage>
      {showEdit && detailReady && (
        <StudentForm
          onSubmit={onEdit}
          onClose={onCloseEdit}
          isLoading={isSaving}
          initialData={detail.editInitialData}
          canManageLifecycle={canManageStudentLifecycle}
        />
      )}
    </div>
  );
}
