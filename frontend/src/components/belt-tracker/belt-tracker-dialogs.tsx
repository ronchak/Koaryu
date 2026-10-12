"use client";

import { DeleteRankConfirmModal } from "@/components/belt-tracker/delete-rank-confirm-modal";
import { DemotionConfirmModal } from "@/components/belt-tracker/demotion-confirm-modal";
import { RankFormModal, type RankFormData } from "@/components/belt-tracker/rank-form-modal";
import { BeltSwatch } from "@/components/belt-tracker/rank-visuals";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { ToneTag } from "@/components/ui/horizon";
import { ModalFrame } from "@/components/ui/modal-frame";
import type { BeltGroup } from "@/lib/belt-tracker-page-model";
import type { BeltRank, EligibilityEntry } from "@/types";
import { ArrowRight, Award } from "lucide-react";
import styles from "./belt-tracker.module.css";

type BeltTrackerDialogsProps = {
  addBeltModalOpen: boolean;
  addTipForGroup: number | null;
  deleteRank: BeltRank | null;
  demoteEntry: EligibilityEntry | null;
  demotionError: string | null;
  demotionReason: string;
  demotionTargetRank: BeltRank | null;
  editRank: BeltRank | null;
  groups: BeltGroup[];
  isPromoting: boolean;
  isDemoting: boolean;
  onAddBeltClose: () => void;
  onAddBeltSave: (data: RankFormData) => void;
  onAddTipClose: () => void;
  onAddTipSave: (groupIndex: number, data: RankFormData) => void;
  onCancelPromotion: () => void;
  onCancelDemotion: () => void;
  onCloseDemotion: () => void;
  onClosePromotion: () => void;
  onConfirmDelete: () => void;
  onConfirmPromotion: () => void;
  onConfirmDemotion: () => void;
  onDeleteCancel: () => void;
  onDismissPromotionError: () => void;
  onDismissDemotionError: () => void;
  onEditClose: () => void;
  onEditSave: (data: RankFormData) => void;
  onPromotionNotesChange: (notes: string) => void;
  onDemotionReasonChange: (reason: string) => void;
  promoteEntry: EligibilityEntry | null;
  promotionError: string | null;
  promotionNotes: string;
  rankById: Map<string, BeltRank>;
  subRankTerm: string;
};

export function BeltTrackerDialogs({
  addBeltModalOpen,
  addTipForGroup,
  deleteRank,
  demoteEntry,
  demotionError,
  demotionReason,
  demotionTargetRank,
  editRank,
  groups,
  isPromoting,
  isDemoting,
  onAddBeltClose,
  onAddBeltSave,
  onAddTipClose,
  onAddTipSave,
  onCancelPromotion,
  onCancelDemotion,
  onCloseDemotion,
  onClosePromotion,
  onConfirmDelete,
  onConfirmPromotion,
  onConfirmDemotion,
  onDeleteCancel,
  onDismissPromotionError,
  onDismissDemotionError,
  onEditClose,
  onEditSave,
  onPromotionNotesChange,
  onDemotionReasonChange,
  promoteEntry,
  promotionError,
  promotionNotes,
  rankById,
  subRankTerm,
}: BeltTrackerDialogsProps) {
  const addTipGroup = addTipForGroup === null ? null : (groups[addTipForGroup] ?? null);

  return (
    <>
      {addBeltModalOpen && (
        <RankFormModal
          title="Add belt"
          forceTip={false}
          subRankTerm={subRankTerm}
          onSave={onAddBeltSave}
          onClose={onAddBeltClose}
        />
      )}

      {addTipForGroup !== null && (
        <RankFormModal
          title={`Add ${subRankTerm} to ${addTipGroup?.belt.name ?? ""}`}
          subRankTerm={subRankTerm}
          forceTip
          initial={{
            color_hex: addTipGroup?.belt.color_hex ?? "#FFFFFF",
            tip_color_hex: "#EF4444",
          }}
          onSave={(data) => onAddTipSave(addTipForGroup, data)}
          onClose={onAddTipClose}
        />
      )}

      {editRank && (
        <RankFormModal
          title={`Edit \u2014 ${editRank.name}`}
          subRankTerm={subRankTerm}
          initial={{
            name: editRank.name,
            is_tip: editRank.is_tip,
            color_hex: editRank.color_hex,
            tip_color_hex: editRank.tip_color_hex ?? "#EF4444",
            min_classes: editRank.min_classes,
            min_months: editRank.min_months,
            requires_approval: editRank.requires_approval,
          }}
          lockType
          onSave={onEditSave}
          onClose={onEditClose}
        />
      )}

      {deleteRank && (
        <DeleteRankConfirmModal
          name={deleteRank.name}
          onConfirm={onConfirmDelete}
          onCancel={onDeleteCancel}
        />
      )}

      {promoteEntry && (
        <PromotionConfirmModal
          isPromoting={isPromoting}
          onCancel={onCancelPromotion}
          onClose={onClosePromotion}
          onConfirm={onConfirmPromotion}
          onDismissError={onDismissPromotionError}
          onNotesChange={onPromotionNotesChange}
          promoteEntry={promoteEntry}
          promotionError={promotionError}
          promotionNotes={promotionNotes}
          rankById={rankById}
        />
      )}

      {demoteEntry && demotionTargetRank ? (
        <DemotionConfirmModal
          entry={demoteEntry}
          error={demotionError}
          isDemoting={isDemoting}
          onCancel={onCancelDemotion}
          onClose={onCloseDemotion}
          onConfirm={onConfirmDemotion}
          onDismissError={onDismissDemotionError}
          onReasonChange={onDemotionReasonChange}
          rankById={rankById}
          reason={demotionReason}
          targetRank={demotionTargetRank}
        />
      ) : null}
    </>
  );
}

type PromotionConfirmModalProps = {
  isPromoting: boolean;
  onCancel: () => void;
  onClose: () => void;
  onConfirm: () => void;
  onDismissError: () => void;
  onNotesChange: (notes: string) => void;
  promoteEntry: EligibilityEntry;
  promotionError: string | null;
  promotionNotes: string;
  rankById: Map<string, BeltRank>;
};

function PromotionConfirmModal({
  isPromoting,
  onCancel,
  onClose,
  onConfirm,
  onDismissError,
  onNotesChange,
  promoteEntry,
  promotionError,
  promotionNotes,
  rankById,
}: PromotionConfirmModalProps) {
  const currentRank = promoteEntry.current_rank_id
    ? rankById.get(promoteEntry.current_rank_id)
    : undefined;
  const nextRank = promoteEntry.next_rank_id ? rankById.get(promoteEntry.next_rank_id) : undefined;

  return (
    <ModalFrame
      rootClassName={`p-4 ${styles.beltDialogRoot}`}
      panelClassName="w-full max-w-md p-5"
      ariaLabelledBy="confirm-promotion-title"
      onBackdropClick={onClose}
    >
      <h2 id="confirm-promotion-title" className={styles.dialogTitle}>
        Confirm Promotion
      </h2>
      <p className={styles.dialogLead}>
        This records {promoteEntry.student_name}&apos;s new rank today.
      </p>
      <div className={styles.dialogStep}>
        <p>{promoteEntry.student_name}</p>
        <div className={styles.beltStep}>
          <span className={styles.beltStepRank}>
            <BeltSwatch
              color={promoteEntry.current_rank_color}
              isTip={currentRank?.is_tip}
              tipColor={currentRank?.tip_color_hex}
              size="md"
            />
            <span>{promoteEntry.current_rank_name ?? "Unranked"}</span>
          </span>
          <ArrowRight aria-hidden="true" className={styles.beltStepArrow} />
          <span className={styles.beltStepRank} data-next="true">
            <BeltSwatch
              color={promoteEntry.next_rank_color}
              isTip={nextRank?.is_tip}
              tipColor={nextRank?.tip_color_hex}
              size="lg"
            />
            <strong>{promoteEntry.next_rank_name}</strong>
          </span>
        </div>
        {promoteEntry.needs_approval ? (
          <ToneTag tone="warn">This rank needs instructor approval</ToneTag>
        ) : null}
      </div>
      <div className={styles.dialogField}>
        <label htmlFor="promotion-notes">Notes (optional)</label>
        <textarea
          id="promotion-notes"
          rows={2}
          value={promotionNotes}
          onChange={(event) => onNotesChange(event.target.value)}
          placeholder="e.g. Excellent guard work"
        />
      </div>
      {promotionError && (
        <DismissibleNotice tone="danger" onDismiss={onDismissError} className="mb-4">
          {promotionError}
        </DismissibleNotice>
      )}
      <div className={styles.dialogActions}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={isPromoting} onClick={onConfirm}>
          <Award aria-hidden="true" className="h-4 w-4" />
          {isPromoting ? "Promoting..." : "Confirm promotion"}
        </Button>
      </div>
    </ModalFrame>
  );
}
