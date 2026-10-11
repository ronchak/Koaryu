"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LEAD_SOURCE_ICONS } from "@/components/leads/lead-source-icons";
import { describeLeadDue, getLeadNextAction } from "@/components/leads/lead-focus";
import { ToneTag } from "@/components/schedule/horizon-parts";
import { Button } from "@/components/ui/button";
import { RevealText } from "@/components/ui/reveal-text";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import {
  LOST_REASON_LABELS,
  PIPELINE_STAGES,
  SOURCE_LABELS,
  formatDate,
  fullName,
  getNextStage,
  getProgramLabel,
  getStageLabel,
} from "@/lib/leads-page-model";
import type { Lead, LeadActivity, LeadStage, LostReason, Program, StaffMember } from "@/types";
import { Clock, Mail, Phone, X } from "lucide-react";
import styles from "./leads-ledger.module.css";

interface LeadDetailInspectorProps {
  activities: LeadActivity[];
  activityError: string | null;
  activityStatus: "idle" | "loading" | "refreshing" | "ready" | "error";
  activeStaff: StaffMember[];
  currentAssignedStaff: StaffMember | null;
  canConvertLeads: boolean;
  canManageLeads: boolean;
  followUpValue: string;
  lead: Lead;
  leadActionError: string | null;
  leadActionMessage: string | null;
  pendingLeadIds: ReadonlySet<string>;
  followUpRecovery: "unknown" | "confirmed" | null;
  trialAppointments?: ReactNode;
  trialRecoveryPending?: boolean;
  onRetryFollowUp: (lead: Lead) => void | Promise<void>;
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

export function LeadDetailInspector({
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
  pendingLeadIds,
  followUpRecovery,
  trialAppointments,
  trialRecoveryPending = false,
  onRetryFollowUp,
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
}: LeadDetailInspectorProps) {
  const inspectorRef = useRef<HTMLElement>(null);
  const isPending = pendingLeadIds.has(lead.id);
  const nextStage = getNextStage(lead.stage);
  const [lostReason, setLostReason] = useState<LostReason>(lead.lost_reason ?? "other");
  const detailStageOptions =
    lead.stage === "closed_lost"
      ? [...PIPELINE_STAGES, { id: "closed_lost" as LeadStage, label: "Closed Lost" }]
      : PIPELINE_STAGES;
  const assigneeChoices =
    currentAssignedStaff && currentAssignedStaff.status !== "active"
      ? [
          currentAssignedStaff,
          ...activeStaff.filter((member) => member.id !== currentAssignedStaff.id),
        ]
      : activeStaff;
  const handleClose = () => {
    onClose();
    window.requestAnimationFrame(() => {
      const opener = document.querySelector<HTMLElement>(`[data-lead-id="${CSS.escape(lead.id)}"]`);
      opener?.focus();
    });
  };

  useEffect(() => {
    inspectorRef.current?.focus();
  }, [lead.id]);

  const program = lead.program_id ? programById.get(lead.program_id) : null;
  const due = describeLeadDue(lead.follow_up_date, today);
  const isOpen = lead.stage !== "closed_lost" && lead.stage !== "enrolled";

  return (
    <aside
      ref={inspectorRef}
      className={styles.inspector}
      aria-labelledby="lead-detail-title"
      aria-busy={(isPending && !followUpRecovery && !trialRecoveryPending) || undefined}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        handleClose();
      }}
    >
      <div className={styles.inspectorHeader}>
        <RevealText as="p">
          {getStageLabel(lead.stage)} · {getProgramLabel(lead, program)}
        </RevealText>
        <h2 id="lead-detail-title">{fullName(lead)}</h2>
        <button
          type="button"
          onClick={handleClose}
          disabled={isPending && !followUpRecovery && !trialRecoveryPending}
          aria-label="Close lead details"
          className={styles.inspectorClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className={styles.inspectorBody}>
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

        {/* The next step comes first: what to do, when, and the buttons to do it. */}
        <section className={styles.nextStep} data-tone={isOpen ? due.tone : "neutral"}>
          <div className={styles.nextStepHead}>
            <div>
              <p className={styles.fieldLabel}>Next step</p>
              <p className={styles.nextStepTitle}>{getLeadNextAction(lead)}</p>
              <p className={styles.nextStepDate}>
                {lead.follow_up_date
                  ? formatDate(lead.follow_up_date, true)
                  : "No follow-up scheduled"}
              </p>
            </div>
            {lead.follow_up_date && isOpen ? (
              <ToneTag tone={due.tone} dot={due.tone !== "neutral"}>
                {due.label}
              </ToneTag>
            ) : null}
          </div>

          {canManageLeads && isOpen && (
            <div className={styles.nextStepActions}>
              {nextStage && (nextStage !== "enrolled" || canConvertLeads) && (
                <Button
                  variant="primary"
                  size="md"
                  disabled={isPending}
                  onClick={() => {
                    void onMarkContacted(lead, true);
                  }}
                >
                  {nextStage === "enrolled" ? "Convert now" : `Move to ${getStageLabel(nextStage)}`}
                </Button>
              )}
              <Button
                variant="secondary"
                size="md"
                disabled={isPending}
                onClick={() => {
                  void onMarkContacted(lead, false);
                }}
              >
                Mark contacted
              </Button>
            </div>
          )}

          {canManageLeads ? (
            <div className={styles.reschedule}>
              <label htmlFor="lead-detail-follow-up-date" className="sr-only">
                Follow-up date
              </label>
              <input
                id="lead-detail-follow-up-date"
                type="date"
                value={followUpValue}
                disabled={isPending}
                onChange={(event) => onFollowUpValueChange(lead.id, event.target.value)}
              />
              <Button
                variant="outline"
                size="md"
                disabled={isPending}
                onClick={() => {
                  void onRescheduleLead(lead);
                }}
              >
                Reschedule
              </Button>
            </div>
          ) : null}

          {canManageLeads && followUpRecovery && (
            <div role="status" className={styles.recovery}>
              <p>
                {followUpRecovery === "confirmed"
                  ? "Follow-up saved. Refresh current lead details before making another change."
                  : "Confirmation was lost. Retry the original follow-up before changing this lead."}
              </p>
              <Button variant="secondary" size="sm" onClick={() => void onRetryFollowUp(lead)}>
                {followUpRecovery === "confirmed" ? "Refresh lead details" : "Retry follow-up"}
              </Button>
            </div>
          )}
        </section>

        {lead.email || lead.phone ? (
          <div className={styles.contact}>
            <p className={styles.fieldLabel}>Contact</p>
            {lead.phone && (
              <a href={`tel:${lead.phone}`} className={styles.contactLink}>
                <Phone aria-hidden="true" />
                <span>{lead.phone}</span>
              </a>
            )}
            {lead.email && (
              <a href={`mailto:${lead.email}`} className={styles.contactLink}>
                <Mail aria-hidden="true" />
                <span>{lead.email}</span>
              </a>
            )}
          </div>
        ) : null}

        <div className={styles.fieldGrid}>
          <div>
            <label htmlFor="lead-detail-stage" className={styles.fieldLabel}>
              Stage
            </label>
            <select
              id="lead-detail-stage"
              value={lead.stage}
              disabled={isPending || !canManageLeads}
              onChange={(event) => {
                void onStageSelection(lead, event.target.value as LeadStage);
              }}
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
          <div>
            <label htmlFor="lead-detail-assignee" className={styles.fieldLabel}>
              Owner
            </label>
            <select
              id="lead-detail-assignee"
              value={lead.assigned_staff_id ?? ""}
              disabled={isPending || !canManageLeads}
              onChange={(event) => void onAssignStaff(lead, event.target.value || null)}
            >
              <option value="">No owner</option>
              {assigneeChoices.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.full_name || member.email}
                  {member.status === "active" ? "" : ` · ${member.status}`}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={styles.fieldGrid}>
          <div>
            <p className={styles.fieldLabel}>Source</p>
            <span className={styles.factPill}>
              {LEAD_SOURCE_ICONS[lead.source]}
              {SOURCE_LABELS[lead.source]}
            </span>
          </div>
          <div>
            <p className={styles.fieldLabel}>Program</p>
            <span
              className={styles.factPill}
              style={
                {
                  "--program-color": program?.color_hex || "var(--product-meta)",
                } as CSSProperties
              }
            >
              <i aria-hidden="true" />
              {getProgramLabel(lead, program)}
            </span>
          </div>
        </div>

        {lead.is_minor && lead.guardian_name && (
          <div className={styles.inspectorCard}>
            <p className={styles.fieldLabel}>Guardian</p>
            <p className={styles.cardStrong}>{lead.guardian_name}</p>
            {lead.guardian_phone && (
              <a href={`tel:${lead.guardian_phone}`} className={styles.contactLink}>
                <Phone aria-hidden="true" />
                <span>{lead.guardian_phone}</span>
              </a>
            )}
            {lead.guardian_email && (
              <a href={`mailto:${lead.guardian_email}`} className={styles.contactLink}>
                <Mail aria-hidden="true" />
                <span>{lead.guardian_email}</span>
              </a>
            )}
          </div>
        )}

        {trialAppointments}

        {lead.notes && (
          <div>
            <p className={styles.fieldLabel}>Notes</p>
            <p className={styles.notes}>{lead.notes}</p>
          </div>
        )}

        <section
          className={styles.activity}
          aria-labelledby="lead-activity-title"
          aria-busy={activityStatus === "loading" || activityStatus === "refreshing"}
        >
          <div className={styles.activityHead}>
            <div>
              <p className={styles.fieldLabel}>Activity</p>
              <h3 id="lead-activity-title">Recorded follow-up trail</h3>
            </div>
            {activityStatus === "refreshing" ? (
              <Clock
                aria-hidden="true"
                className="h-4 w-4 animate-pulse text-muted motion-reduce:animate-none"
              />
            ) : null}
          </div>
          {activityStatus === "error" ? (
            <div className={styles.activityError}>
              <p>{activityError || "Could not load lead activity."}</p>
              <Button variant="secondary" size="sm" className="mt-2" onClick={onRetryActivities}>
                Retry activity
              </Button>
            </div>
          ) : null}
          {(activityStatus === "ready" || activityStatus === "refreshing") &&
          activities.length === 0 ? (
            <p className={styles.activityEmpty}>No activity has been recorded for this lead yet.</p>
          ) : activityStatus === "loading" && activities.length === 0 ? (
            <div
              className={`koaryu-skeleton-reveal ${styles.activityList}`}
              role="status"
              aria-live="polite"
            >
              <p className="sr-only">Loading lead activity.</p>
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className={styles.activityItem} aria-hidden="true">
                  <span className={`${styles.stateBar} w-3/4`} />
                  <span className={`${styles.stateBar} mt-1 w-1/2`} />
                </div>
              ))}
            </div>
          ) : (
            <ol className={styles.activityList}>
              {activities.map((activity) => (
                <li key={activity.id} className={styles.activityItem}>
                  <p>{activity.description || activity.activity_type.replace(/_/g, " ")}</p>
                  <p>
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
          <div className={styles.lostReason}>
            <p className={styles.fieldLabel}>Lost reason</p>
            <p>{lead.lost_reason.replace(/_/g, " ")}</p>
          </div>
        )}

        {canManageLeads && isOpen ? (
          <div className={styles.closeOut}>
            {canConvertLeads && (
              <Button
                variant="secondary"
                size="md"
                disabled={isPending}
                onClick={() => {
                  void onConvertLead(lead);
                }}
              >
                Convert to student
              </Button>
            )}
            <div className={styles.markLost}>
              <label htmlFor="lead-lost-reason">
                Lost reason
                <select
                  id="lead-lost-reason"
                  value={lostReason}
                  disabled={isPending}
                  onChange={(event) => setLostReason(event.target.value as LostReason)}
                >
                  {Object.entries(LOST_REASON_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="danger"
                size="md"
                disabled={isPending}
                onClick={() => void onMarkLost(lead, lostReason)}
              >
                Mark lost
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
