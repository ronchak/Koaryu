"use client";

import { RankBadge } from "@/components/belt-tracker/rank-visuals";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { ModalFrame } from "@/components/ui/modal-frame";
import type { BeltRank, EligibilityEntry } from "@/types";
import { ChevronDown } from "lucide-react";

type DemotionConfirmModalProps = {
  entry: EligibilityEntry;
  error: string | null;
  isDemoting: boolean;
  onCancel: () => void;
  onClose: () => void;
  onConfirm: () => void;
  onDismissError: () => void;
  onReasonChange: (reason: string) => void;
  rankById: Map<string, BeltRank>;
  reason: string;
  targetRank: BeltRank;
};

export function DemotionConfirmModal({
  entry,
  error,
  isDemoting,
  onCancel,
  onClose,
  onConfirm,
  onDismissError,
  onReasonChange,
  rankById,
  reason,
  targetRank,
}: DemotionConfirmModalProps) {
  const currentRank = entry.current_rank_id
    ? rankById.get(entry.current_rank_id)
    : undefined;

  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="bg-bg border border-border rounded-[6px] w-full max-w-sm p-6"
      ariaLabelledBy="confirm-demotion-title"
      onBackdropClick={onClose}
    >
      <h2 id="confirm-demotion-title" className="text-base font-semibold text-text-primary">
        Confirm demotion
      </h2>
      <div className="my-4 rounded-[6px] border border-border bg-surface p-4">
        <p className="text-sm font-medium text-text-primary">{entry.student_name}</p>
        <div className="mt-2 flex items-center gap-2">
          {currentRank ? (
            <RankBadge
              name={currentRank.name}
              color={currentRank.color_hex}
              isTip={currentRank.is_tip}
              tipColor={currentRank.tip_color_hex ?? undefined}
            />
          ) : null}
          <span className="text-muted">{"\u2192"}</span>
          <RankBadge
            name={targetRank.name}
            color={targetRank.color_hex}
            isTip={targetRank.is_tip}
            tipColor={targetRank.tip_color_hex ?? undefined}
          />
        </div>
      </div>
      <div className="mb-4 flex flex-col gap-1.5">
        <label htmlFor="demotion-reason" className="text-sm font-medium text-text-secondary">
          Reason (required)
        </label>
        <textarea
          id="demotion-reason"
          rows={3}
          required
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder="Explain why this rank correction is needed"
          className="w-full resize-none rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </div>
      {error ? (
        <DismissibleNotice tone="danger" onDismiss={onDismissError} className="mb-4">
          {error}
        </DismissibleNotice>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isDemoting}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={isDemoting || !reason.trim()}
          onClick={onConfirm}
        >
          <ChevronDown className="h-3.5 w-3.5" />
          {isDemoting ? "Demoting..." : "Confirm demotion"}
        </Button>
      </div>
    </ModalFrame>
  );
}
