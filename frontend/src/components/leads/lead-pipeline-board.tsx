"use client";

import type { DragEvent, KeyboardEvent } from "react";
import { LEAD_SOURCE_ICONS } from "@/components/leads/lead-source-icons";
import {
  PIPELINE_STAGES,
  SOURCE_LABELS,
  formatDate,
  fullName,
  getFollowUpStatusLabel,
  getProgramLabel,
  timeAgo,
} from "@/lib/leads-page-model";
import type { Lead, LeadStage, Program } from "@/types";
import { Calendar, GripVertical } from "lucide-react";

interface LeadPipelineBoardProps {
  canConvertLeads: boolean;
  draggedLeadId: string | null;
  draggedLeadRecord: Lead | null;
  dropTargetStage: LeadStage | null;
  leadsByStage: Partial<Record<LeadStage, Lead[]>>;
  pendingLeadId: string | null;
  programById: Map<string, Program>;
  today: string;
  onAddLead: () => void;
  onCardDragEnd: () => void;
  onCardDragStart: (
    event: DragEvent<HTMLDivElement>,
    leadId: string
  ) => void;
  onDrop: (
    event: DragEvent<HTMLDivElement>,
    stage: LeadStage
  ) => void | Promise<void>;
  onKeyboardMoveLead: (lead: Lead, direction: -1 | 1) => void | Promise<void>;
  onSelectLead: (leadId: string) => void;
  onStageDragLeave: (
    event: DragEvent<HTMLDivElement>,
    stage: LeadStage
  ) => void;
  onStageDragOver: (
    event: DragEvent<HTMLDivElement>,
    stage: LeadStage
  ) => void;
}

export function LeadPipelineBoard({
  canConvertLeads,
  draggedLeadId,
  draggedLeadRecord,
  dropTargetStage,
  leadsByStage,
  pendingLeadId,
  programById,
  today,
  onAddLead,
  onCardDragEnd,
  onCardDragStart,
  onDrop,
  onKeyboardMoveLead,
  onSelectLead,
  onStageDragLeave,
  onStageDragOver,
}: LeadPipelineBoardProps) {
  return (
    <div className="flex-1 p-4 sm:p-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-5">
        {PIPELINE_STAGES.map((stage) => {
          const stageLeads = leadsByStage[stage.id] || [];
          const canDropIntoStage =
            draggedLeadRecord?.stage !== undefined &&
            draggedLeadRecord.stage !== stage.id &&
            (stage.id !== "enrolled" || canConvertLeads);
          const isDropActive = canDropIntoStage && dropTargetStage === stage.id;

          return (
            <LeadPipelineStageColumn
              key={stage.id}
              canDropIntoStage={canDropIntoStage}
              draggedLeadId={draggedLeadId}
              isDropActive={isDropActive}
              pendingLeadId={pendingLeadId}
              programById={programById}
              stage={stage}
              stageLeads={stageLeads}
              today={today}
              onAddLead={onAddLead}
              onCardDragEnd={onCardDragEnd}
              onCardDragStart={onCardDragStart}
              onDrop={onDrop}
              onKeyboardMoveLead={onKeyboardMoveLead}
              onSelectLead={onSelectLead}
              onStageDragLeave={onStageDragLeave}
              onStageDragOver={onStageDragOver}
            />
          );
        })}
      </div>
    </div>
  );
}

interface LeadPipelineStageColumnProps {
  canDropIntoStage: boolean;
  draggedLeadId: string | null;
  isDropActive: boolean;
  pendingLeadId: string | null;
  programById: Map<string, Program>;
  stage: (typeof PIPELINE_STAGES)[number];
  stageLeads: Lead[];
  today: string;
  onAddLead: () => void;
  onCardDragEnd: () => void;
  onCardDragStart: (
    event: DragEvent<HTMLDivElement>,
    leadId: string
  ) => void;
  onDrop: (
    event: DragEvent<HTMLDivElement>,
    stage: LeadStage
  ) => void | Promise<void>;
  onKeyboardMoveLead: (lead: Lead, direction: -1 | 1) => void | Promise<void>;
  onSelectLead: (leadId: string) => void;
  onStageDragLeave: (
    event: DragEvent<HTMLDivElement>,
    stage: LeadStage
  ) => void;
  onStageDragOver: (
    event: DragEvent<HTMLDivElement>,
    stage: LeadStage
  ) => void;
}

function LeadPipelineStageColumn({
  canDropIntoStage,
  draggedLeadId,
  isDropActive,
  pendingLeadId,
  programById,
  stage,
  stageLeads,
  today,
  onAddLead,
  onCardDragEnd,
  onCardDragStart,
  onDrop,
  onKeyboardMoveLead,
  onSelectLead,
  onStageDragLeave,
  onStageDragOver,
}: LeadPipelineStageColumnProps) {
  return (
    <div
      className={`min-w-0 flex flex-col transition-colors ${
        isDropActive ? "ring-1 ring-accent/50" : ""
      }`}
      onDragOver={(event) => onStageDragOver(event, stage.id)}
      onDragLeave={(event) => onStageDragLeave(event, stage.id)}
      onDrop={(event) => {
        event.stopPropagation();
        void onDrop(event, stage.id);
      }}
    >
      <span
        className="block h-[3px] w-full shrink-0"
        style={{ backgroundColor: stage.hex }}
      />

      <div className="flex items-center justify-between px-3 py-2.5 bg-surface border-x border-border">
        <h3 className="text-[11px] font-medium text-text-secondary uppercase tracking-widest">
          {stage.label}
        </h3>
        <span className="text-[11px] text-muted font-mono">
          {stageLeads.length}
        </span>
      </div>

      <div
        className={`flex-1 border border-border border-t-0 p-2 transition-colors ${
          isDropActive ? "bg-accent/[0.04]" : "bg-surface/30"
        } min-h-[240px]`}
        onDragOver={(event) => onStageDragOver(event, stage.id)}
        onDragLeave={(event) => onStageDragLeave(event, stage.id)}
        onDrop={(event) => {
          event.stopPropagation();
          void onDrop(event, stage.id);
        }}
      >
        {canDropIntoStage && (
          <div
            className={`border border-dashed px-3 py-2 text-xs mb-2 transition-colors ${
              isDropActive
                ? "border-accent/60 bg-accent/10 text-accent"
                : "border-border bg-surface-raised/40 text-muted"
            }`}
          >
            Drop to move to {stage.label.toLowerCase()}
          </div>
        )}

        {stageLeads.map((lead) => (
          <LeadPipelineCard
            key={lead.id}
            draggedLeadId={draggedLeadId}
            lead={lead}
            pendingLeadId={pendingLeadId}
            programById={programById}
            today={today}
            onCardDragEnd={onCardDragEnd}
            onCardDragStart={onCardDragStart}
            onKeyboardMoveLead={onKeyboardMoveLead}
            onSelectLead={onSelectLead}
          />
        ))}

        {stageLeads.length === 0 && (
          <LeadStageEmptyState stage={stage} onAddLead={onAddLead} />
        )}
      </div>
    </div>
  );
}

interface LeadPipelineCardProps {
  draggedLeadId: string | null;
  lead: Lead;
  pendingLeadId: string | null;
  programById: Map<string, Program>;
  today: string;
  onCardDragEnd: () => void;
  onCardDragStart: (
    event: DragEvent<HTMLDivElement>,
    leadId: string
  ) => void;
  onKeyboardMoveLead: (lead: Lead, direction: -1 | 1) => void | Promise<void>;
  onSelectLead: (leadId: string) => void;
}

function LeadPipelineCard({
  draggedLeadId,
  lead,
  pendingLeadId,
  programById,
  today,
  onCardDragEnd,
  onCardDragStart,
  onKeyboardMoveLead,
  onSelectLead,
}: LeadPipelineCardProps) {
  const program = lead.program_id ? programById.get(lead.program_id) : null;
  const cardAccent = program?.color_hex || "var(--border)";

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectLead(lead.id);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      void onKeyboardMoveLead(lead, 1);
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      void onKeyboardMoveLead(lead, -1);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(event) => onCardDragStart(event, lead.id)}
      onDragEnd={onCardDragEnd}
      onClick={() => onSelectLead(lead.id)}
      onKeyDown={handleKeyDown}
      aria-label={`${fullName(lead)} lead card`}
      className={`group relative min-w-0 bg-surface border border-border mb-2 cursor-pointer hover:border-[color:var(--accent)]/30 transition-colors overflow-hidden ${
        draggedLeadId === lead.id || pendingLeadId === lead.id
          ? "opacity-50"
          : ""
      }`}
    >
      <span
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ backgroundColor: cardAccent }}
      />
      <div className="pl-3.5 pr-3 py-2.5">
        <div className="flex items-start justify-between gap-1">
          <p className="break-words text-sm font-semibold text-text-primary leading-tight">
            {fullName(lead)}
          </p>
          <GripVertical className="w-3 h-3 text-border flex-shrink-0 cursor-grab mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        <p className="text-[10px] text-text-secondary mt-1 truncate">
          {getProgramLabel(lead, program)}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 border border-border bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-secondary">
            {LEAD_SOURCE_ICONS[lead.source]}
            <span className="truncate">{SOURCE_LABELS[lead.source]}</span>
          </span>
          {lead.is_minor && (
            <span className="text-[10px] text-warning">Minor</span>
          )}
          {lead.follow_up_date && lead.follow_up_date <= today && (
            <span
              className={`text-[10px] px-1.5 py-0.5 ${
                lead.follow_up_date < today
                  ? "bg-danger/10 text-danger"
                  : "bg-warning/10 text-warning"
              }`}
            >
              {getFollowUpStatusLabel(lead.follow_up_date, today)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 mt-2 pt-1.5 border-t border-border/40 text-[10px] text-muted">
          {lead.follow_up_date && (
            <span className="flex items-center gap-0.5">
              <Calendar className="w-2.5 h-2.5" />
              {formatDate(lead.follow_up_date)}
            </span>
          )}
          <span>{timeAgo(lead.created_at)}</span>
        </div>
      </div>
    </div>
  );
}

interface LeadStageEmptyStateProps {
  stage: (typeof PIPELINE_STAGES)[number];
  onAddLead: () => void;
}

function LeadStageEmptyState({ stage, onAddLead }: LeadStageEmptyStateProps) {
  return (
    <div className="text-center py-8">
      <p className="text-xs text-muted">
        {stage.id === "inquiry"
          ? "New inquiries will start here."
          : `No leads in ${stage.label.toLowerCase()}.`}
      </p>
      {stage.id === "inquiry" ? (
        <button
          type="button"
          onClick={onAddLead}
          className="mt-3 text-xs font-medium text-accent hover:text-accent-hover cursor-pointer"
        >
          Add lead
        </button>
      ) : null}
    </div>
  );
}
