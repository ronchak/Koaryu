"use client";

import { ProgramPicker } from "@/components/programs/program-picker";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { ModalFrame } from "@/components/ui/modal-frame";
import { SOURCE_LABELS } from "@/lib/leads-page-model";
import type { Lead, LeadSource, Program } from "@/types";
import { X } from "lucide-react";

interface AddLeadModalProps {
  activePrograms: Program[];
  addLeadError: string | null;
  isAddingLead: boolean;
  programById: Map<string, Program>;
  selectedProgramId: string | null;
  today: string;
  onClose: () => void;
  onDismissError: () => void;
  onProgramChange: (programId: string | null) => void;
  onSubmit: (data: Partial<Lead>) => void | Promise<void>;
}

export function AddLeadModal({
  activePrograms,
  addLeadError,
  isAddingLead,
  programById,
  selectedProgramId,
  today,
  onClose,
  onDismissError,
  onProgramChange,
  onSubmit,
}: AddLeadModalProps) {
  function closeIfIdle() {
    if (!isAddingLead) {
      onClose();
    }
  }

  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="max-h-[85vh] w-full max-w-md overflow-y-auto border border-border bg-bg p-5 sm:p-6"
      ariaLabelledBy="add-lead-title"
      onBackdropClick={closeIfIdle}
    >
      <div className="flex items-center justify-between mb-6">
        <h2 id="add-lead-title" className="text-base font-semibold text-text-primary">Add new lead</h2>
        <button
          type="button"
          onClick={closeIfIdle}
          aria-label="Close add lead dialog"
          disabled={isAddingLead}
          className="text-muted hover:text-text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          void onSubmit({
            first_name: formData.get("first_name") as string,
            last_name: formData.get("last_name") as string,
            email: (formData.get("email") as string) || undefined,
            phone: (formData.get("phone") as string) || undefined,
            source: formData.get("source") as LeadSource,
            program_id: selectedProgramId,
            program_interest: selectedProgramId
              ? programById.get(selectedProgramId)?.name
              : undefined,
            follow_up_date:
              (formData.get("follow_up_date") as string) || undefined,
            is_minor: formData.get("is_minor") === "on",
            guardian_name:
              (formData.get("guardian_name") as string) || undefined,
            guardian_email:
              (formData.get("guardian_email") as string) || undefined,
            guardian_phone:
              (formData.get("guardian_phone") as string) || undefined,
            notes: (formData.get("notes") as string) || undefined,
          });
        }}
        className="space-y-4"
      >
        {addLeadError && (
          <DismissibleNotice tone="danger" onDismiss={onDismissError}>
            {addLeadError}
          </DismissibleNotice>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="lead-first-name" className="text-sm text-text-secondary font-medium">
              First name *
            </label>
            <input
              id="lead-first-name"
              name="first_name"
              required
              disabled={isAddingLead}
              className="w-full px-3 py-2 text-sm bg-surface-raised border border-border text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="lead-last-name" className="text-sm text-text-secondary font-medium">
              Last name *
            </label>
            <input
              id="lead-last-name"
              name="last_name"
              required
              disabled={isAddingLead}
              className="w-full px-3 py-2 text-sm bg-surface-raised border border-border text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="lead-email" className="text-sm text-text-secondary font-medium">Email</label>
          <input
            id="lead-email"
            name="email"
            type="email"
            disabled={isAddingLead}
            className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="lead-phone" className="text-sm text-text-secondary font-medium">Phone</label>
            <input
              id="lead-phone"
              name="phone"
              type="tel"
              disabled={isAddingLead}
              className="w-full px-3 py-2 text-sm bg-surface-raised border border-border text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="lead-source" className="text-sm text-text-secondary font-medium">Source</label>
            <select
              id="lead-source"
              name="source"
              defaultValue="walk_in"
              disabled={isAddingLead}
              className="w-full px-3 py-2 text-sm bg-surface-raised border border-border text-text-primary focus:border-accent focus:outline-none"
            >
              {Object.entries(SOURCE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <ProgramPicker
            programs={activePrograms}
            value={selectedProgramId}
            onChange={onProgramChange}
            label="Program"
            allowEmpty
            disabled={isAddingLead}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="lead-follow-up-date" className="text-sm text-text-secondary font-medium">
            Follow-up date
          </label>
          <input
            id="lead-follow-up-date"
            name="follow_up_date"
            type="date"
            defaultValue={today}
            disabled={isAddingLead}
            className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            name="is_minor"
            type="checkbox"
            disabled={isAddingLead}
            className="accent-[var(--accent)]"
          />
          Minor lead
        </label>
        <div className="grid grid-cols-1 gap-3 border border-border bg-surface/60 p-3">
          <p className="text-xs font-medium text-text-secondary">Guardian details</p>
          <input
            aria-label="Guardian name"
            name="guardian_name"
            placeholder="Guardian name"
            disabled={isAddingLead}
            className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              aria-label="Guardian email"
              name="guardian_email"
              type="email"
              placeholder="Guardian email"
              disabled={isAddingLead}
              className="w-full px-3 py-2 text-sm bg-surface-raised border border-border text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <input
              aria-label="Guardian phone"
              name="guardian_phone"
              type="tel"
              placeholder="Guardian phone"
              disabled={isAddingLead}
              className="w-full px-3 py-2 text-sm bg-surface-raised border border-border text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="lead-notes" className="text-sm text-text-secondary font-medium">Notes</label>
          <textarea
            id="lead-notes"
            name="notes"
            rows={2}
            disabled={isAddingLead}
            className="w-full px-3 py-2 text-sm bg-surface-raised border border-border text-text-primary placeholder:text-muted focus:border-accent focus:outline-none resize-none"
          />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={isAddingLead}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={isAddingLead}>
            {isAddingLead ? "Saving..." : "Add lead"}
          </Button>
        </div>
      </form>
    </ModalFrame>
  );
}
