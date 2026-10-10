"use client";

import { Button } from "@/components/ui/button";
import { ModalFrame } from "@/components/ui/modal-frame";
import { Trash2 } from "lucide-react";
import styles from "./belt-tracker.module.css";

export function DeleteRankConfirmModal({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalFrame
      rootClassName={`p-4 ${styles.beltDialogRoot}`}
      panelClassName="w-full max-w-sm p-5"
      ariaLabelledBy="delete-rank-title"
      ariaDescribedBy="delete-rank-description"
      onBackdropClick={onCancel}
    >
      <h2 id="delete-rank-title" className={styles.dialogTitle}>
        Delete rank?
      </h2>
      <p id="delete-rank-description" className={`${styles.dialogLead} mb-5`}>
        <strong className="text-text-primary">{name}</strong> will be permanently removed. Students
        at this rank may need reassignment.
      </p>
      <div className={styles.dialogActions}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          <Trash2 aria-hidden="true" className="h-4 w-4" /> Delete
        </Button>
      </div>
    </ModalFrame>
  );
}
