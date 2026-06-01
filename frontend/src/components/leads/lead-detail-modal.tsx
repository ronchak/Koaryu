"use client";

import { LEAD_SOURCE_ICONS } from "@/components/leads/lead-source-icons";
import { ProgramBadge } from "@/components/programs/program-picker";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { ModalFrame } from "@/components/ui/modal-frame";
import {
  PIPELINE_STAGES,
  SOURCE_LABELS,
  formatDate,
  fullName,
  getFollowUpStatusLabel,
  getNextStage,
  getProgramLabel,
  getStageLabel,
} from "@/lib/leads-page-model";
import type { Lead, LeadStage, Program } from "@/types";
import { Mail, Phone, X } from "lucide-react";

interface LeadDetailModalProps {
  followUpValue: string;
  lead: Lead;
  leadActionError: string | null;
  pendingLeadId: string | null;
  programById: Map<string, Program>;
  today: string;
  onClose: () => void;
  onConvertLead: (lead: Lead) => void | Promise<void>;
  onDismissError: () => void;
  onFollowUpValueChange: (leadId: string, value: string) => void;
  onMarkContacted: (lead: Lead, advanceStage: boolean) => void | Promise<void>;
  onMarkLost: (lead: Lead) => void | Promise<void>;
  onRescheduleLead: (lead: Lead) => void | Promise<void>;
  onStageSelection: (lead: Lead, nextStage: LeadStage) => void | Promise<void>;
}

export function LeadDetailModal({
  followUpValue,
  lead,
  leadActionError,
  pendingLeadId,
  programById,
  today,
  onClose,
  onConvertLead,
  onDismissError,
  onFollowUpValueChange,
  onMarkContacted,
  onMarkLost,
  onRescheduleLead,
  onStageSelection,
}: LeadDetailModalProps) {
  const isPending = pendingLeadId === lead.id;
  const nextStage = getNextStage(lead.stage);

  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="max-h-[80vh] w-full max-w-md overflow-y-auto border border-border bg-bg"
      ariaLabelledBy="lead-detail-title"
      onBackdropClick={onClose}
    >
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <h2 id="lead-detail-title" className="text-base font-semibold text-text-primary">
          {fullName(lead)}
        </h2>
        <button
          type="button"
          onClick={onClose}
          disabled={isPending}
          aria-label="Close lead details"
          className="text-muted hover:text-text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-5 space-y-4">
        {leadActionError && (
          <DismissibleNotice tone="danger" onDismiss={onDismissError}>
            {leadActionError}
          </DismissibleNotice>
        )}

        <div>
          <label htmlFor="lead-detail-stage" className="block text-xs text-muted mb-1.5">Stage</label>
          <select
            id="lead-detail-stage"
            value={lead.stage}
            disabled={isPending}
            onChange={(event) => {
              void onStageSelection(lead, event.target.value as LeadStage);
            }}
            className="w-full px-3 py-1.5 text-sm bg-surface-raised border border-border text-text-primary focus:border-accent focus:outline-none"
          >
            {[...PIPELINE_STAGES, { id: "closed_lost" as LeadStage, label: "Closed Lost" }].map(
              (stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.label}
                </option>
              )
            )}
          </select>
        </div>

        <div className="space-y-2">
          <p className="text-xs text-muted">Contact</p>
          {lead.email && (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Mail className="w-3.5 h-3.5 text-muted" />
              <span className="font-mono">{lead.email}</span>
            </div>
          )}
          {lead.phone && (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Phone className="w-3.5 h-3.5 text-muted" />
              <span className="font-mono">{lead.phone}</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted mb-1">Source</p>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-surface-raised border border-border text-text-secondary">
              {LEAD_SOURCE_ICONS[lead.source]}
              {SOURCE_LABELS[lead.source]}
            </span>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Program</p>
            <ProgramBadge
              program={lead.program_id ? programById.get(lead.program_id) : null}
              fallback={getProgramLabel(lead, null)}
            />
          </div>
        </div>

        {lead.is_minor && lead.guardian_name && (
          <div className="bg-surface border border-border p-3">
            <p className="text-xs text-muted mb-2">Guardian</p>
            <p className="text-sm text-text-primary">{lead.guardian_name}</p>
            {lead.guardian_email && (
              <p className="text-xs text-text-secondary font-mono mt-1">
                {lead.guardian_email}
              </p>
            )}
            {lead.guardian_phone && (
              <p className="text-xs text-text-secondary font-mono mt-0.5">
                {lead.guardian_phone}
              </p>
            )}
          </div>
        )}

        <div className="bg-surface border border-border p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-muted">Follow-up date</p>
              <p className="text-sm text-text-primary mt-1">
                {lead.follow_up_date
                  ? formatDate(lead.follow_up_date, true)
                  : "No follow-up scheduled"}
              </p>
            </div>
            {lead.follow_up_date && lead.follow_up_date <= today && (
              <span
                className={`px-2 py-1 text-xs ${
                  lead.follow_up_date < today
                    ? "bg-danger/10 text-danger"
                    : "bg-warning/10 text-warning"
                }`}
              >
                {getFollowUpStatusLabel(lead.follow_up_date, today)}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label htmlFor="lead-detail-follow-up-date" className="sr-only">
              Follow-up date
            </label>
            <input
              id="lead-detail-follow-up-date"
              type="date"
              value={followUpValue}
              disabled={isPending}
              onChange={(event) =>
                onFollowUpValueChange(lead.id, event.target.value)
              }
              className="w-full border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={isPending}
              onClick={() => {
                void onRescheduleLead(lead);
              }}
            >
              Reschedule
            </Button>
          </div>

          {lead.stage !== "closed_lost" && lead.stage !== "enrolled" && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={() => {
                  void onMarkContacted(lead, false);
                }}
              >
                Mark contacted
              </Button>
              {nextStage && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={isPending}
                  onClick={() => {
                    void onMarkContacted(lead, true);
                  }}
                >
                  {nextStage === "enrolled"
                    ? "Convert now"
                    : `Move to ${getStageLabel(nextStage)}`}
                </Button>
              )}
            </div>
          )}
        </div>

        {lead.notes && (
          <div>
            <p className="text-xs text-muted mb-1">Notes</p>
            <p className="text-sm text-text-secondary leading-relaxed">
              {lead.notes}
            </p>
          </div>
        )}

        {lead.stage === "closed_lost" && lead.lost_reason && (
          <div className="bg-danger/5 border border-danger/20 p-3">
            <p className="text-xs text-danger mb-1">Lost reason</p>
            <p className="text-sm text-text-primary capitalize">
              {lead.lost_reason.replace(/_/g, " ")}
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
          {lead.stage !== "enrolled" && lead.stage !== "closed_lost" && (
            <Button
              variant="primary"
              size="sm"
              disabled={isPending}
              onClick={() => {
                void onConvertLead(lead);
              }}
            >
              Convert to student
            </Button>
          )}
          {lead.stage !== "closed_lost" && lead.stage !== "enrolled" && (
            <Button
              variant="danger"
              size="sm"
              disabled={isPending}
              onClick={() => {
                void onMarkLost(lead);
              }}
            >
              Mark lost
            </Button>
          )}
        </div>
      </div>
    </ModalFrame>
  );
}
