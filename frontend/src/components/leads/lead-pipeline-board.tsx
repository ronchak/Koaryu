"use client";

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
import type { Lead, LeadStage, Program, StaffMember } from "@/types";
import { ChevronLeft, ChevronRight, UserPlus } from "lucide-react";
import styles from "./leads-ledger.module.css";

interface LeadPipelineBoardProps {
  canConvertLeads: boolean;
  canManageLeads: boolean;
  leads: Lead[];
  pendingLeadId: string | null;
  programById: Map<string, Program>;
  staffById: Map<string, StaffMember>;
  today: string;
  onAddLead: () => void;
  onKeyboardMoveLead: (lead: Lead, direction: -1 | 1) => void | Promise<void>;
  onSelectLead: (leadId: string) => void;
  onStageSelection: (lead: Lead, nextStage: LeadStage) => void | Promise<void>;
}

export function LeadPipelineBoard({
  canConvertLeads,
  canManageLeads,
  leads,
  pendingLeadId,
  programById,
  staffById,
  today,
  onAddLead,
  onKeyboardMoveLead,
  onSelectLead,
  onStageSelection,
}: LeadPipelineBoardProps) {
  const overdue = leads.filter((lead) => lead.follow_up_date && lead.follow_up_date < today).length;
  const dueToday = leads.filter((lead) => lead.follow_up_date === today).length;
  const unassigned = leads.filter((lead) => !lead.assigned_staff_id).length;

  if (leads.length === 0) {
    return (
      <section className={styles.empty} aria-labelledby="lead-ledger-title">
        <p className={styles.eyebrow}>Obligation ledger</p>
        <h2 id="lead-ledger-title">No open lead obligations.</h2>
        <p>The old stage columns are gone. New inquiries will appear here in follow-up order.</p>
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
    <section className={styles.workspace} aria-labelledby="lead-ledger-title">
      <div className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>Obligation ledger</p>
          <h2 id="lead-ledger-title">Who needs a follow-up next?</h2>
          <p>Ordered by the promise due, replacing stage columns with one accountable queue.</p>
        </div>
        <dl className={styles.totals}>
          <div><dt>Overdue</dt><dd>{overdue}</dd></div>
          <div><dt>Due today</dt><dd>{dueToday}</dd></div>
          <div><dt>Unassigned</dt><dd>{unassigned}</dd></div>
        </dl>
      </div>

      <div className={styles.tableFrame}>
        <table className={styles.ledger}>
          <thead>
            <tr>
              <th scope="col">Obligation</th>
              <th scope="col">Lead</th>
              <th scope="col">Stage</th>
              <th scope="col">Program / source</th>
              <th scope="col">Owner</th>
              <th scope="col"><span className="sr-only">Open record</span></th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => {
              const stageIndex = PIPELINE_STAGES.findIndex((stage) => stage.id === lead.stage);
              const owner = lead.assigned_staff_id ? staffById.get(lead.assigned_staff_id) : null;
              const isPending = pendingLeadId === lead.id;
              const obligation = lead.follow_up_date
                ? getFollowUpStatusLabel(lead.follow_up_date, today)
                : lead.stage === "enrolled" ? "Completed" : "Not scheduled";
              const tone = lead.follow_up_date && lead.follow_up_date < today
                ? "overdue"
                : lead.follow_up_date === today ? "today" : "quiet";

              return (
                <tr key={lead.id} data-obligation={tone} aria-busy={isPending || undefined}>
                  <td data-label="Obligation" className={styles.obligation}>
                    <span>{obligation}</span>
                    {lead.follow_up_date ? <small>{formatDate(lead.follow_up_date, true)}</small> : null}
                  </td>
                  <th scope="row" data-label="Lead">
                    <button type="button" onClick={() => onSelectLead(lead.id)} className={styles.nameButton}>
                      {fullName(lead)}
                    </button>
                    <small>{lead.email || lead.phone || "No contact details"}</small>
                  </th>
                  <td data-label="Stage" className={styles.stageCell}>
                    {canManageLeads ? (
                      <>
                        <select
                          aria-label={`Stage for ${fullName(lead)}`}
                          value={lead.stage}
                          disabled={isPending}
                          onChange={(event) => void onStageSelection(lead, event.target.value as LeadStage)}
                        >
                          {PIPELINE_STAGES.map((stage) => (
                            <option key={stage.id} value={stage.id} disabled={stage.id === "enrolled" && !canConvertLeads}>
                              {stage.label}
                            </option>
                          ))}
                        </select>
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
                      </>
                    ) : <span className={styles.readOnlyStage}>{getStageLabel(lead.stage)}</span>}
                  </td>
                  <td data-label="Program / source">
                    <span>{getProgramLabel(lead, lead.program_id ? programById.get(lead.program_id) : null)}</span>
                    <small>{SOURCE_LABELS[lead.source]}{lead.is_minor ? " · Minor" : ""}</small>
                  </td>
                  <td data-label="Owner">
                    <span>{owner?.full_name || owner?.email || "Unassigned"}</span>
                  </td>
                  <td data-label="Record">
                    <Button variant="ghost" size="sm" disabled={isPending} onClick={() => onSelectLead(lead.id)}>
                      Open
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
