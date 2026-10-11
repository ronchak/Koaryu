"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/schedule/horizon-parts";
import {
  PIPELINE_STAGES,
  SOURCE_LABELS,
  fullName,
  getProgramLabel,
  getStageLabel,
} from "@/lib/leads-page-model";
import type { Lead, Program, StaffMember } from "@/types";
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, UserPlus, X } from "lucide-react";
import { LEAD_AGE_BANDS, groupLeadsByAgeBand, type LeadAgeBandId } from "@/lib/leads-age-bands";
import {
  describeLeadDue,
  describeLeadFocus,
  getLeadNextAction,
  matchesLeadFocus,
  type LeadFocus,
} from "./lead-focus";
import styles from "./leads-ledger.module.css";

interface LeadPipelineBoardProps {
  canConvertLeads: boolean;
  canManageLeads: boolean;
  leads: Lead[];
  pendingLeadIds: ReadonlySet<string>;
  recoveringLeadIds: ReadonlySet<string>;
  programById: Map<string, Program>;
  selectedLeadId: string | null;
  staffById: Map<string, StaffMember>;
  today: string;
  /** The queue filter; the board keeps its own when the page does not own one. */
  focus?: LeadFocus | null;
  onFocusChange?: (focus: LeadFocus | null) => void;
  onAddLead: () => void;
  onKeyboardMoveLead: (lead: Lead, direction: -1 | 1) => void | Promise<void>;
  onSelectLead: (leadId: string) => void;
}

const BAND_TONE: Record<LeadAgeBandId, "alert" | "warn" | "neutral"> = {
  overdue: "alert",
  today: "warn",
  upcoming: "neutral",
  unscheduled: "neutral",
};

/*
 * Rows say how late or how soon only where the band header does not: "Due today"
 * and "Nothing due" already say it for every row in them.
 */
const BAND_SHOWS_DUE: Record<LeadAgeBandId, boolean> = {
  overdue: true,
  today: false,
  upcoming: true,
  unscheduled: false,
};

function initials(lead: Lead) {
  return `${lead.first_name?.[0] ?? ""}${lead.last_name?.[0] ?? ""}`.toUpperCase() || "?";
}

function LeadLedgerErrorIntro() {
  return (
    <div className={styles.intro}>
      <div>
        <h2 id="lead-ledger-state-title">The follow-up queue could not be loaded.</h2>
        <p>Review the error below, then retry.</p>
      </div>
    </div>
  );
}

export function LeadLedgerLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <section className={styles.workspace} aria-labelledby="lead-ledger-state-title">
      <LeadLedgerErrorIntro />
      <div className={styles.stateFrame} role="alert">
        <div className={styles.stateMessage}>
          <AlertTriangle aria-hidden="true" className="h-6 w-6 shrink-0 text-danger" />
          <div>
            <p className={styles.stateText}>{error}</p>
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
  pendingLeadIds,
  recoveringLeadIds,
  programById,
  selectedLeadId,
  staffById,
  today,
  focus: controlledFocus,
  onFocusChange,
  onAddLead,
  onKeyboardMoveLead,
  onSelectLead,
}: LeadPipelineBoardProps) {
  const [ownFocus, setOwnFocus] = useState<LeadFocus | null>(null);
  const focus = controlledFocus === undefined ? ownFocus : controlledFocus;
  const setFocus = onFocusChange ?? setOwnFocus;
  const visibleLeads = useMemo(
    () => leads.filter((lead) => matchesLeadFocus(lead, focus, today)),
    [focus, leads, today],
  );
  const leadsByBand = useMemo(
    () => groupLeadsByAgeBand(visibleLeads, today),
    [visibleLeads, today],
  );

  if (leads.length === 0) {
    return (
      <section className={styles.empty} aria-labelledby="lead-ledger-title">
        <h2 id="lead-ledger-title">No open leads.</h2>
        <p>New inquiries show up here, soonest follow-up first.</p>
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
      {focus ? (
        <div className={styles.focusBar} role="status">
          <p>
            Showing {describeLeadFocus(focus)} · <b>{visibleLeads.length}</b>
          </p>
          <button type="button" className={styles.focusClear} onClick={() => setFocus(null)}>
            <X aria-hidden="true" />
            Show all leads
          </button>
        </div>
      ) : null}

      <div className={styles.ageQueue} aria-label="Lead next-action queue">
        {visibleLeads.length === 0 ? (
          <CalmState
            icon={<Inbox />}
            title={`No ${focus ? describeLeadFocus(focus) : "leads"} right now.`}
            detail="Nothing waits on you here."
            action={
              <Button variant="secondary" size="sm" onClick={() => setFocus(null)}>
                Show all leads
              </Button>
            }
          />
        ) : null}
        {LEAD_AGE_BANDS.map((band) => {
          const bandLeads = leadsByBand.get(band.id) ?? [];
          if (bandLeads.length === 0) return null;
          const tone = BAND_TONE[band.id];
          return (
            <section
              key={band.id}
              className={styles.ageBand}
              data-age-band={band.id}
              data-tone={tone}
            >
              <header>
                <h2>{band.label}</h2>
                <span>{bandLeads.length}</span>
              </header>
              <ol>
                {bandLeads.map((lead) => {
                  const stageIndex = PIPELINE_STAGES.findIndex((stage) => stage.id === lead.stage);
                  const owner = lead.assigned_staff_id
                    ? staffById.get(lead.assigned_staff_id)
                    : null;
                  const ownerName = owner?.full_name || owner?.email || null;
                  const isPending = pendingLeadIds.has(lead.id);
                  const isSelected = selectedLeadId === lead.id;
                  const due = BAND_SHOWS_DUE[band.id]
                    ? describeLeadDue(lead.follow_up_date, today)
                    : null;
                  const name = fullName(lead);
                  const stageAndProgram = `${getStageLabel(lead.stage)} · ${getProgramLabel(
                    lead,
                    lead.program_id ? programById.get(lead.program_id) : null,
                  )}`;
                  return (
                    <li
                      key={lead.id}
                      data-selected={isSelected || undefined}
                      data-follow-up-state={band.id}
                      aria-busy={isPending || undefined}
                    >
                      <span className={styles.leadInitials} aria-hidden="true">
                        {initials(lead)}
                      </span>
                      {/* The whole row opens the lead; the name is its visible label. */}
                      <button
                        type="button"
                        data-lead-id={lead.id}
                        className={styles.queueLead}
                        disabled={isPending && !recoveringLeadIds.has(lead.id)}
                        aria-pressed={isSelected}
                        aria-label={`${name} ${stageAndProgram}`}
                        onClick={() => onSelectLead(lead.id)}
                      >
                        {name}
                      </button>
                      <span className={styles.queueAction} data-due={due ? "true" : undefined}>
                        <strong>{getLeadNextAction(lead)}</strong>
                        {/*
                         * A no-break space joins the due label to the step's last word,
                         * so a wrap moves "attendance · Due tomorrow" down together.
                         */}
                        {due ? (
                          <span className={styles.leadDue} data-tone={due.tone}>
                            <span className={styles.dueGap}>{"\u00a0"}</span>
                            {due.label}
                          </span>
                        ) : null}
                      </span>
                      {/*
                       * Desktop sets these in their own columns; narrow rows run them
                       * together as one wrapping line under the next step. The stage
                       * line is already in the row button's name, so it is read once.
                       */}
                      <span className={styles.queueContext}>
                        <span
                          className={styles.leadStage}
                          title={stageAndProgram}
                          aria-hidden="true"
                        >
                          {stageAndProgram}
                        </span>
                        <span className={styles.leadSource}>
                          {SOURCE_LABELS[lead.source]}
                          {lead.is_minor ? " · Minor" : ""}
                        </span>
                        <span
                          className={styles.leadOwner}
                          data-unassigned={ownerName ? undefined : "true"}
                        >
                          {ownerName ?? "No owner"}
                        </span>
                      </span>
                      {canManageLeads ? (
                        <div className={styles.stageMoves} aria-label={`Move ${name} one stage`}>
                          <button
                            type="button"
                            data-move="previous"
                            aria-label={`Move ${name} to the previous stage`}
                            disabled={stageIndex <= 0 || isPending}
                            onClick={() => void onKeyboardMoveLead(lead, -1)}
                          >
                            <ChevronLeft aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            data-move="next"
                            aria-label={`Move ${name} to the next stage`}
                            disabled={
                              stageIndex < 0 ||
                              stageIndex >= PIPELINE_STAGES.length - 1 ||
                              isPending ||
                              (PIPELINE_STAGES[stageIndex + 1]?.id === "enrolled" &&
                                !canConvertLeads)
                            }
                            onClick={() => void onKeyboardMoveLead(lead, 1)}
                          >
                            <ChevronRight aria-hidden="true" />
                          </button>
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
