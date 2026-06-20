"use client";

import { Button } from "@/components/ui/button";
import { ModalFrame } from "@/components/ui/modal-frame";
import { Trash2 } from "lucide-react";

export function DeleteRankConfirmModal({ name, onConfirm, onCancel }: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="bg-bg border border-border rounded-[6px] w-full max-w-xs p-6"
      ariaLabelledBy="delete-rank-title"
      ariaDescribedBy="delete-rank-description"
      onBackdropClick={onCancel}
    >
      <h2 id="delete-rank-title" className="text-base font-semibold text-text-primary mb-2">Delete rank?</h2>
      <p id="delete-rank-description" className="text-sm text-text-secondary mb-4">
        <strong className="text-text-primary">{name}</strong> will be permanently removed.
        Students at this rank may need reassignment.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onConfirm}
          className="!bg-danger hover:!bg-danger/80"
        >
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </Button>
      </div>
    </ModalFrame>
  );
}
