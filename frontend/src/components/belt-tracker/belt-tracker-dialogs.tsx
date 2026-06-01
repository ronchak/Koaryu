"use client";

import { DeleteRankConfirmModal } from "@/components/belt-tracker/delete-rank-confirm-modal";
import { RankFormModal, type RankFormData } from "@/components/belt-tracker/rank-form-modal";
import { RankBadge } from "@/components/belt-tracker/rank-visuals";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { ModalFrame } from "@/components/ui/modal-frame";
import type { BeltGroup } from "@/lib/belt-tracker-page-model";
import type { BeltRank, EligibilityEntry } from "@/types";
import { Award } from "lucide-react";

type BeltTrackerDialogsProps = {
  addBeltModalOpen: boolean;
  addTipForGroup: number | null;
  deleteRank: BeltRank | null;
  editRank: BeltRank | null;
  groups: BeltGroup[];
  isPromoting: boolean;
  onAddBeltClose: () => void;
  onAddBeltSave: (data: RankFormData) => void;
  onAddTipClose: () => void;
  onAddTipSave: (groupIndex: number, data: RankFormData) => void;
  onCancelPromotion: () => void;
  onClosePromotion: () => void;
  onConfirmDelete: () => void;
  onConfirmPromotion: () => void;
  onDeleteCancel: () => void;
  onDismissPromotionError: () => void;
  onEditClose: () => void;
  onEditSave: (data: RankFormData) => void;
  onPromotionNotesChange: (notes: string) => void;
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
  editRank,
  groups,
  isPromoting,
  onAddBeltClose,
  onAddBeltSave,
  onAddTipClose,
  onAddTipSave,
  onCancelPromotion,
  onClosePromotion,
  onConfirmDelete,
  onConfirmPromotion,
  onDeleteCancel,
  onDismissPromotionError,
  onEditClose,
  onEditSave,
  onPromotionNotesChange,
  promoteEntry,
  promotionError,
  promotionNotes,
  rankById,
  subRankTerm,
}: BeltTrackerDialogsProps) {
  const addTipGroup = addTipForGroup === null ? null : groups[addTipForGroup] ?? null;

  return (
    <>
      {addBeltModalOpen && (
        <RankFormModal
          title="Add belt"
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
  const nextRank = promoteEntry.next_rank_id
    ? rankById.get(promoteEntry.next_rank_id)
    : undefined;

  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="bg-bg border border-border rounded-[6px] w-full max-w-sm p-6"
      ariaLabelledBy="confirm-promotion-title"
      onBackdropClick={onClose}
    >
      <h2 id="confirm-promotion-title" className="text-base font-semibold text-text-primary mb-4">
        Confirm Promotion
      </h2>
      <div className="bg-surface border border-border rounded-[6px] p-4 mb-4">
        <p className="text-sm text-text-primary font-medium">{promoteEntry.student_name}</p>
        <div className="flex items-center gap-2 mt-2">
          {promoteEntry.current_rank_name && promoteEntry.current_rank_color && (
            <RankBadge
              name={promoteEntry.current_rank_name}
              color={promoteEntry.current_rank_color}
              isTip={currentRank?.is_tip}
              tipColor={currentRank?.tip_color_hex ?? undefined}
            />
          )}
          <span className="text-muted">{"\u2192"}</span>
          {promoteEntry.next_rank_name && promoteEntry.next_rank_color && (
            <RankBadge
              name={promoteEntry.next_rank_name}
              color={promoteEntry.next_rank_color}
              isTip={nextRank?.is_tip}
              tipColor={nextRank?.tip_color_hex ?? undefined}
            />
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 mb-4">
        <label className="text-sm text-text-secondary font-medium">Notes (optional)</label>
        <textarea
          rows={2}
          value={promotionNotes}
          onChange={(event) => onNotesChange(event.target.value)}
          placeholder="e.g. Excellent guard work"
          className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none resize-none"
        />
      </div>
      {promotionError && (
        <DismissibleNotice
          tone="danger"
          onDismiss={onDismissError}
          className="mb-4"
        >
          {promotionError}
        </DismissibleNotice>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={isPromoting} onClick={onConfirm}>
          <Award className="w-3.5 h-3.5" />
          {isPromoting ? "Promoting..." : "Confirm promotion"}
        </Button>
      </div>
    </ModalFrame>
  );
}
