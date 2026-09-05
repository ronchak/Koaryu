"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  PIPELINE_STAGES,
  SOURCE_LABELS,
  formatDate,
  fullName,
  getFollowUpStatusLabel,
  getProgramLabel,
  getStageLabel,
} from "@/lib/leads-page-model";
import type { Lead, Program, StaffMember } from "@/types";
import { AlertTriangle, ChevronLeft, ChevronRight, UserPlus } from "lucide-react";
import { LEAD_AGE_BANDS, groupLeadsByAgeBand } from "@/lib/leads-age-bands";
import styles from "./leads-ledger.module.css";

interface LeadPipelineBoardProps {
  canConvertLeads: boolean;
  canManageLeads: boolean;
  leads: Lead[];
  pendingLeadId: string | null;
  programById: Map<string, Program>;
  selectedLeadId: string | null;
  staffById: Map<string, StaffMember>;
  today: string;
  onAddLead: () => void;
  onKeyboardMoveLead: (lead: Lead, direction: -1 | 1) => void | Promise<void>;
  onSelectLead: (leadId: string) => void;
}

function getLeadNextAction(lead: Lead) {
  if (lead.stage === "enrolled") return "Enrollment complete";
  if (!lead.follow_up_date) return "Schedule the next contact";
  switch (lead.stage) {
    case "inquiry": return "Make first contact";
    case "trial_scheduled": return "Confirm trial attendance";
    case "trial_completed": return "Review trial and next step";
    case "offer_sent": return "Follow up on the offer";
    case "closed_lost": return "Review closed record";
  }
}

function LeadLedgerErrorIntro() {
  return (
    <div className={styles.intro}>
      <div>
        <h2 id="lead-ledger-state-title">The follow-up queue could not be loaded.</h2>
        <p>Review the error below, then retry.</p>
      </div>
      <dl className={styles.totals} aria-hidden="true">
        <div><dt>Overdue</dt><dd>—</dd></div>
        <div><dt>Due today</dt><dd>—</dd></div>
        <div><dt>Unassigned</dt><dd>—</dd></div>
      </dl>
    </div>
  );
}

export function LeadLedgerLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <section className={styles.workspace} aria-labelledby="lead-ledger-state-title">
      <LeadLedgerErrorIntro />
      <div className={styles.stateFrame} role="alert">
        <div className={`${styles.stateMessage} p-4`}>
          <AlertTriangle aria-hidden="true" className="h-6 w-6 shrink-0 text-danger" />
          <div>
            <p className="max-w-xl text-sm text-text-secondary">{error}</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
              Retry lead roster
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function LeadPipelineBoard({
  canConvertLeads,
  canManageLeads,
  leads,
  pendingLeadId,
  programById,
  selectedLeadId,
  staffById,
  today,
  onAddLead,
  onKeyboardMoveLead,
  onSelectLead,
}: LeadPipelineBoardProps) {
  const overdue = leads.filter((lead) => lead.follow_up_date && lead.follow_up_date < today).length;
  const dueToday = leads.filter((lead) => lead.follow_up_date === today).length;
  const unassigned = leads.filter((lead) => !lead.assigned_staff_id).length;
  const leadsByBand = useMemo(() => groupLeadsByAgeBand(leads, today), [leads, today]);

  if (leads.length === 0) {
    return (
      <section className={styles.empty} aria-labelledby="lead-ledger-title">
        <h2 id="lead-ledger-title">No open lead obligations.</h2>
        <p>New inquiries will appear here in follow-up order.</p>
        {canManageLeads ? (
          <Button variant="primary" size="sm" onClick={onAddLead}>
            <UserPlus aria-hidden="true" className="h-3.5 w-3.5" />
            Add lead
          </Button>
        ) : null}
      </section>
    );
  }

  return (
    <section className={styles.workspace} aria-label="Open lead obligations">
      <div className={styles.intro}>
        <dl className={styles.totals}>
          <div><dt>Overdue</dt><dd>{overdue}</dd></div>
          <div><dt>Due today</dt><dd>{dueToday}</dd></div>
          <div><dt>Unassigned</dt><dd>{unassigned}</dd></div>
        </dl>
      </div>

      <ol className={styles.stageRail} aria-label="Lead stages">
        {PIPELINE_STAGES.map((stage) => {
          const count = leads.filter((lead) => lead.stage === stage.id).length;
          return (
            <li key={stage.id}>
              <strong>{stage.label}</strong>
              <b>{count}</b>
            </li>
          );
        })}
      </ol>

      <div className={styles.ageQueue} aria-label="Lead next-action queue">
        {LEAD_AGE_BANDS.map((band) => {
          const bandLeads = leadsByBand.get(band.id) ?? [];
          if (bandLeads.length === 0) return null;
          return (
            <section key={band.id} className={styles.ageBand} data-age-band={band.id}>
              <header>
                <h2>{band.label}</h2>
                <span>{bandLeads.length}</span>
              </header>
              <ol>
                {bandLeads.map((lead) => {
                  const stageIndex = PIPELINE_STAGES.findIndex((stage) => stage.id === lead.stage);
                  const owner = lead.assigned_staff_id ? staffById.get(lead.assigned_staff_id) : null;
                  const isPending = pendingLeadId === lead.id;
                  const isSelected = selectedLeadId === lead.id;
                  return (
                    <li
                      key={lead.id}
                      data-selected={isSelected || undefined}
                      data-follow-up-state={band.id}
                      aria-busy={isPending || undefined}
                    >
                      <button
                        type="button"
                        data-lead-id={lead.id}
                        className={styles.queueLead}
                        disabled={isPending}
                        aria-pressed={isSelected}
                        onClick={() => onSelectLead(lead.id)}
                      >
                        <strong>{fullName(lead)}</strong>
                        <span>{getStageLabel(lead.stage)} · {getProgramLabel(lead, lead.program_id ? programById.get(lead.program_id) : null)}</span>
                      </button>
                      <div className={styles.queueAction}>
                        <strong>{getLeadNextAction(lead)}</strong>
                        <span>
                          {lead.follow_up_date ? `${getFollowUpStatusLabel(lead.follow_up_date, today)} · ${formatDate(lead.follow_up_date, true)}` : "No follow-up date"}
                        </span>
                      </div>
                      <div className={styles.queueContext}>
                        <span>{owner?.full_name || owner?.email || "Unassigned"}</span>
                        <small>{SOURCE_LABELS[lead.source]}{lead.is_minor ? " · Minor" : ""}</small>
                      </div>
                      {canManageLeads ? (
                        <div className={styles.stageMoves} aria-label={`Move ${fullName(lead)} one stage`}>
                          <button
                            type="button"
                            aria-label={`Move ${fullName(lead)} to the previous stage`}
                            disabled={stageIndex <= 0 || isPending}
                            onClick={() => void onKeyboardMoveLead(lead, -1)}
                          ><ChevronLeft aria-hidden="true" /></button>
                          <button
                            type="button"
                            aria-label={`Move ${fullName(lead)} to the next stage`}
                            disabled={stageIndex < 0 || stageIndex >= PIPELINE_STAGES.length - 1 || isPending || (PIPELINE_STAGES[stageIndex + 1]?.id === "enrolled" && !canConvertLeads)}
                            onClick={() => void onKeyboardMoveLead(lead, 1)}
                          ><ChevronRight aria-hidden="true" /></button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
    </section>
  );
}
