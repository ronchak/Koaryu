"use client";

import { useState } from "react";
import { LEAD_SOURCE_ICONS } from "@/components/leads/lead-source-icons";
import { ProgramBadge } from "@/components/programs/program-picker";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { ModalFrame } from "@/components/ui/modal-frame";
import {
  LOST_REASON_LABELS,
  PIPELINE_STAGES,
  SOURCE_LABELS,
  formatDate,
  fullName,
  getFollowUpStatusLabel,
  getNextStage,
  getProgramLabel,
  getStageLabel,
} from "@/lib/leads-page-model";
import type { Lead, LeadActivity, LeadStage, LostReason, Program, StaffMember } from "@/types";
import { Clock, Mail, Phone, X } from "lucide-react";

interface LeadDetailModalProps {
  activities: LeadActivity[];
  activityError: string | null;
  activityStatus: "idle" | "loading" | "ready" | "error";
  activeStaff: StaffMember[];
  currentAssignedStaff: StaffMember | null;
  canConvertLeads: boolean;
  canManageLeads: boolean;
  followUpValue: string;
  lead: Lead;
  leadActionError: string | null;
  leadActionMessage: string | null;
  pendingLeadId: string | null;
  programById: Map<string, Program>;
  today: string;
  onAssignStaff: (lead: Lead, assignedStaffId: string | null) => void | Promise<void>;
  onClose: () => void;
  onConvertLead: (lead: Lead) => void | Promise<void>;
  onDismissError: () => void;
  onDismissMessage: () => void;
  onFollowUpValueChange: (leadId: string, value: string) => void;
  onMarkContacted: (lead: Lead, advanceStage: boolean) => void | Promise<void>;
  onMarkLost: (lead: Lead, lostReason: LostReason) => void | Promise<void>;
  onRetryActivities: () => void;
  onRescheduleLead: (lead: Lead) => void | Promise<void>;
  onStageSelection: (lead: Lead, nextStage: LeadStage) => void | Promise<void>;
}

export function LeadDetailModal({
  activities,
  activityError,
  activityStatus,
  activeStaff,
  currentAssignedStaff,
  canConvertLeads,
  canManageLeads,
  followUpValue,
  lead,
  leadActionError,
  leadActionMessage,
  pendingLeadId,
  programById,
  today,
  onAssignStaff,
  onClose,
  onConvertLead,
  onDismissError,
  onDismissMessage,
  onFollowUpValueChange,
  onMarkContacted,
  onMarkLost,
  onRetryActivities,
  onRescheduleLead,
  onStageSelection,
}: LeadDetailModalProps) {
  const isPending = pendingLeadId === lead.id;
  const nextStage = getNextStage(lead.stage);
  const [lostReason, setLostReason] = useState<LostReason>(lead.lost_reason ?? "other");
  const detailStageOptions = lead.stage === "closed_lost"
    ? [...PIPELINE_STAGES, { id: "closed_lost" as LeadStage, label: "Closed Lost" }]
    : PIPELINE_STAGES;
  const assigneeChoices = currentAssignedStaff && currentAssignedStaff.status !== "active"
    ? [currentAssignedStaff, ...activeStaff.filter((member) => member.id !== currentAssignedStaff.id)]
    : activeStaff;

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
        {leadActionMessage && (
          <DismissibleNotice tone="success" onDismiss={onDismissMessage}>
            {leadActionMessage}
          </DismissibleNotice>
        )}

        <div>
          <label htmlFor="lead-detail-stage" className="block text-xs text-muted mb-1.5">Stage</label>
          <select
            id="lead-detail-stage"
            value={lead.stage}
            disabled={isPending || !canManageLeads}
            onChange={(event) => {
              void onStageSelection(lead, event.target.value as LeadStage);
            }}
            className="w-full px-3 py-1.5 text-sm bg-surface-raised border border-border text-text-primary focus:border-accent focus:outline-none"
          >
            {detailStageOptions.map((stage) => (
                <option
                  key={stage.id}
                  value={stage.id}
                  disabled={stage.id === "enrolled" && !canConvertLeads}
                >
                  {stage.label}
                </option>
              ))}
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

        <div>
          <label htmlFor="lead-detail-assignee" className="block text-xs text-muted mb-1.5">Assigned staff</label>
          <select
            id="lead-detail-assignee"
            value={lead.assigned_staff_id ?? ""}
            disabled={isPending || !canManageLeads}
            onChange={(event) => void onAssignStaff(lead, event.target.value || null)}
            className="min-h-11 w-full border border-border bg-surface-raised px-3 text-sm text-text-primary focus:border-accent focus:outline-none"
          >
            <option value="">Unassigned</option>
            {assigneeChoices.map((member) => (
              <option key={member.id} value={member.id}>
                {member.full_name || member.email}
                {member.status === "active" ? "" : ` · ${member.status}`}
              </option>
            ))}
          </select>
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

          {canManageLeads ? (
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
          ) : null}

          {canManageLeads && lead.stage !== "closed_lost" && lead.stage !== "enrolled" && (
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
              {nextStage && (nextStage !== "enrolled" || canConvertLeads) && (
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

        <section className="border-y border-border py-4" aria-labelledby="lead-activity-title">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Activity</p>
              <h3 id="lead-activity-title" className="mt-1 text-sm font-semibold text-text-primary">Recorded follow-up trail</h3>
            </div>
            {activityStatus === "loading" ? (
              <Clock aria-hidden="true" className="h-4 w-4 animate-pulse text-muted motion-reduce:animate-none" />
            ) : null}
          </div>
          {activityStatus === "error" ? (
            <div className="mt-3 text-sm text-danger">
              <p>{activityError || "Could not load lead activity."}</p>
              <Button variant="ghost" size="sm" className="mt-2" onClick={onRetryActivities}>Retry activity</Button>
            </div>
          ) : activityStatus === "ready" && activities.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No activity has been recorded for this lead yet.</p>
          ) : (
            <ol className="mt-3 space-y-3">
              {activities.map((activity) => (
                <li key={activity.id} className="border-l-2 border-border pl-3">
                  <p className="text-sm text-text-primary">{activity.description || activity.activity_type.replace(/_/g, " ")}</p>
                  <p className="mt-1 text-xs text-muted">
                    {new Date(activity.created_at).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>

        {lead.stage === "closed_lost" && lead.lost_reason && (
          <div className="bg-danger/5 border border-danger/20 p-3">
            <p className="text-xs text-danger mb-1">Lost reason</p>
            <p className="text-sm text-text-primary capitalize">
              {lead.lost_reason.replace(/_/g, " ")}
            </p>
          </div>
        )}

        {canManageLeads ? (
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
          {canConvertLeads && lead.stage !== "enrolled" && lead.stage !== "closed_lost" && (
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
            <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2 border-l-2 border-danger/40 pl-3">
              <label className="min-w-40 flex-1 text-xs text-muted" htmlFor="lead-lost-reason">
                Lost reason
                <select
                  id="lead-lost-reason"
                  value={lostReason}
                  disabled={isPending}
                  onChange={(event) => setLostReason(event.target.value as LostReason)}
                  className="mt-1 min-h-11 w-full border border-border bg-surface-raised px-2 text-sm text-text-primary"
                >
                  {Object.entries(LOST_REASON_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <Button
                variant="danger"
                size="sm"
                disabled={isPending}
                onClick={() => void onMarkLost(lead, lostReason)}
              >
                Mark lost
              </Button>
            </div>
          )}
          </div>
        ) : null}
      </div>
    </ModalFrame>
  );
}
