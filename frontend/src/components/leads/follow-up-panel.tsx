"use client";

import { LEAD_SOURCE_ICONS } from "@/components/leads/lead-source-icons";
import { ProgramBadge } from "@/components/programs/program-picker";
import { Button } from "@/components/ui/button";
import {
  SOURCE_LABELS,
  fullName,
  getFollowUpStatusLabel,
  getNextStage,
  getProgramLabel,
  getStageLabel,
} from "@/lib/leads-page-model";
import type { Lead, Program } from "@/types";

interface FollowUpPanelProps {
  dueTodayCount: number;
  followUpQueue: Lead[];
  overdueCount: number;
  pendingLeadId: string | null;
  programById: Map<string, Program>;
  today: string;
  upcomingFollowUps: number;
  getFollowUpInputValue: (lead: Lead) => string;
  onFollowUpInputChange: (leadId: string, value: string) => void;
  onMarkContacted: (lead: Lead, advanceStage: boolean) => void | Promise<void>;
  onRescheduleLead: (lead: Lead) => void | Promise<void>;
  onSelectLead: (leadId: string) => void;
}

export function FollowUpPanel({
  dueTodayCount,
  followUpQueue,
  overdueCount,
  pendingLeadId,
  programById,
  today,
  upcomingFollowUps,
  getFollowUpInputValue,
  onFollowUpInputChange,
  onMarkContacted,
  onRescheduleLead,
  onSelectLead,
}: FollowUpPanelProps) {
  return (
    <div className="px-4 pt-4 sm:px-6 lg:px-8 lg:pt-6">
      <div className="border border-border bg-surface p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-text-primary">Follow-Up Today</h3>
            <p className="text-sm text-text-secondary mt-1">
              Keep due leads moving with one-click contact, reschedule, and stage actions.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="border border-warning/20 bg-warning/10 px-2 py-1 text-warning">
              {dueTodayCount} due today
            </span>
            <span className="border border-danger/20 bg-danger/10 px-2 py-1 text-danger">
              {overdueCount} overdue
            </span>
            <span className="border border-border bg-surface-raised px-2 py-1 text-text-secondary">
              {upcomingFollowUps} upcoming
            </span>
          </div>
        </div>

        {followUpQueue.length === 0 ? (
          <div className="mt-4 border border-border bg-surface-raised/60 px-4 py-5 text-sm text-text-secondary">
            No leads are due for follow-up today. Upcoming follow-ups will continue to show on each lead card.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {followUpQueue.map((lead) => {
              const nextStage = getNextStage(lead.stage);
              const isPending = pendingLeadId === lead.id;

              return (
                <div
                  key={lead.id}
                  className="border border-border bg-surface-raised/60 p-4"
                >
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div className="min-w-0">
                      <button
                        onClick={() => onSelectLead(lead.id)}
                        className="text-left cursor-pointer"
                      >
                        <p className="text-sm font-medium text-text-primary">
                          {fullName(lead)}
                        </p>
                        <div className="mt-1">
                          <ProgramBadge
                            program={lead.program_id ? programById.get(lead.program_id) : null}
                            fallback={getProgramLabel(lead, null)}
                          />
                        </div>
                      </button>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                        <span className="border border-border bg-surface px-2 py-0.5">
                          {getStageLabel(lead.stage)}
                        </span>
                        <span className="inline-flex items-center gap-1 border border-border bg-surface px-2 py-0.5">
                          {LEAD_SOURCE_ICONS[lead.source]}
                          {SOURCE_LABELS[lead.source]}
                        </span>
                        {lead.follow_up_date && (
                          <span
                            className={`px-2 py-0.5 ${
                              lead.follow_up_date < today
                                ? "bg-danger/10 text-danger"
                                : "bg-warning/10 text-warning"
                            }`}
                          >
                            {getFollowUpStatusLabel(lead.follow_up_date, today)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(150px,auto)_repeat(3,minmax(0,auto))] sm:items-end">
                      <div className="min-w-0">
                        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                          Next follow-up
                        </label>
                        <input
                          type="date"
                          value={getFollowUpInputValue(lead)}
                          disabled={isPending}
                          onChange={(event) =>
                            onFollowUpInputChange(lead.id, event.target.value)
                          }
                          className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </div>
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
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
