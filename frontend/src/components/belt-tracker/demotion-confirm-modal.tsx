"use client";

import { BeltSwatch } from "@/components/belt-tracker/rank-visuals";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { ModalFrame } from "@/components/ui/modal-frame";
import type { BeltRank, EligibilityEntry } from "@/types";
import { ArrowRight, ChevronDown } from "lucide-react";
import styles from "./belt-tracker.module.css";

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
  const currentRank = entry.current_rank_id ? rankById.get(entry.current_rank_id) : undefined;

  return (
    <ModalFrame
      rootClassName={`p-4 ${styles.beltDialogRoot}`}
      panelClassName="w-full max-w-md p-5"
      ariaLabelledBy="confirm-demotion-title"
      onBackdropClick={onClose}
    >
      <h2 id="confirm-demotion-title" className={styles.dialogTitle}>
        Confirm demotion
      </h2>
      <p className={styles.dialogLead}>
        A rank correction moves {entry.student_name} back one rank and keeps the reason on record.
      </p>
      <div className={styles.dialogStep}>
        <p>{entry.student_name}</p>
        <div className={styles.beltStep}>
          <span className={styles.beltStepRank}>
            <BeltSwatch
              color={currentRank?.color_hex ?? entry.current_rank_color}
              isTip={currentRank?.is_tip}
              tipColor={currentRank?.tip_color_hex}
              size="md"
            />
            <span>{currentRank?.name ?? entry.current_rank_name ?? "Current rank"}</span>
          </span>
          <ArrowRight aria-hidden="true" className={styles.beltStepArrow} />
          <span className={styles.beltStepRank} data-next="true">
            <BeltSwatch
              color={targetRank.color_hex}
              isTip={targetRank.is_tip}
              tipColor={targetRank.tip_color_hex}
              size="lg"
            />
            <strong>{targetRank.name}</strong>
          </span>
        </div>
      </div>
      <div className={styles.dialogField}>
        <label htmlFor="demotion-reason">Reason (required)</label>
        <textarea
          id="demotion-reason"
          rows={3}
          required
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder="Explain why this rank correction is needed"
        />
      </div>
      {error ? (
        <DismissibleNotice tone="danger" onDismiss={onDismissError} className="mb-4">
          {error}
        </DismissibleNotice>
      ) : null}
      <div className={styles.dialogActions}>
        <Button variant="ghost" onClick={onCancel} disabled={isDemoting}>
          Cancel
        </Button>
        <Button variant="danger" disabled={isDemoting || !reason.trim()} onClick={onConfirm}>
          <ChevronDown aria-hidden="true" className="h-4 w-4" />
          {isDemoting ? "Demoting..." : "Confirm demotion"}
        </Button>
      </div>
    </ModalFrame>
  );
}
