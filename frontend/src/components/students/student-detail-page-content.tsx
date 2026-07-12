"use client";

import { Header } from "@/components/header";
import { StudentDetailSections } from "@/components/students/student-detail-sections";
import { StudentDetailSidebar } from "@/components/students/student-detail-sidebar";
import { StudentForm } from "@/components/students/student-form";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import type { StudentDetailPageController } from "@/lib/student-detail-page-controller";
import { AlertTriangle, ArrowLeft, Pencil, Trash2 } from "lucide-react";

type StudentDetailPageContentProps = StudentDetailPageController["contentProps"];

export function StudentDetailPageContent({
  actionMessage,
  beltLoadError,
  canManageRoster,
  deleteError,
  detail,
  isDeleting,
  isLoadingBeltData,
  isLoadingStudent,
  isPhotoSaving,
  isSaving,
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
  onShowDeleteConfirm,
  onShowEdit,
}: StudentDetailPageContentProps) {
  if (isLoadingStudent) {
    return (
      <>
        <Header title="Loading student" />
        <div className="flex-1 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      </>
    );
  }

  if (!student || !detail) {
    return (
      <>
        <Header title="Student not found">
          <Button variant="ghost" size="sm" onClick={onBackToStudents}>
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Button>
        </Header>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-text-secondary">
              {loadError || "This student doesn't exist or has been deleted."}
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header title={detail.fullName} description="Student profile">
        <Button variant="ghost" size="sm" onClick={onBackToStudents}>
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to students
        </Button>
        <Button variant="secondary" size="sm" onClick={onShowEdit}>
          <Pencil className="w-3.5 h-3.5" />
          Edit
        </Button>
        {canManageRoster ? (
          <Button variant="danger" size="sm" onClick={onShowDeleteConfirm}>
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </Button>
        ) : null}
      </Header>

      {actionMessage ? (
        <div className="px-8 pt-4">
          <DismissibleNotice tone="success" onDismiss={onDismissActionMessage}>
            {actionMessage}
          </DismissibleNotice>
        </div>
      ) : null}

      <div className="flex-1 p-8">
        <div className="max-w-3xl grid grid-cols-3 gap-6">
          {canManageRoster && (showDeleteConfirm || deleteError) && (
            <div className="col-span-3 rounded-[6px] border border-danger/20 bg-danger/5 px-4 py-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0" />
                    <p className="text-sm font-medium text-text-primary">Delete this student?</p>
                  </div>
                  <p className="text-xs text-muted mt-1">
                    This removes {detail.fullName} from the active roster and cannot be undone from the UI.
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
                    onClick={onDeleteStudent}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          )}

          <StudentDetailSidebar
            student={student}
            fullName={detail.fullName}
            programs={programs}
            activeProgramIds={detail.activeProgramIds}
            photoPreviewUrl={photoPreviewUrl}
            photoError={photoError}
            isPhotoSaving={isPhotoSaving}
            onPhotoSelected={onPhotoSelected}
            onDeletePhoto={onDeletePhoto}
            isCurrentHold={detail.isCurrentHold}
            currentRank={detail.currentRank}
            nextRank={detail.nextRank}
            latestPromotionAt={detail.latestPromotion?.promoted_at}
            promotionCount={promotionHistory.length}
            isLoadingBeltData={isLoadingBeltData}
            beltLoadError={beltLoadError}
          />

          <StudentDetailSections
            student={student}
            primaryGuardian={detail.primaryGuardian}
            currentRank={detail.currentRank}
            promotionHistory={promotionHistory}
            rankById={detail.rankById}
            isCurrentHold={detail.isCurrentHold}
            isLoadingBeltData={isLoadingBeltData}
            beltLoadError={beltLoadError}
          />
        </div>
      </div>

      {showEdit && (
        <StudentForm
          onSubmit={onEdit}
          onClose={onCloseEdit}
          isLoading={isSaving}
          initialData={detail.editInitialData}
        />
      )}
    </>
  );
}
