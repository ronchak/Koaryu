"use client";

import type { DragEvent, FormEvent } from "react";
import { BeltVisual } from "@/components/belt-tracker/rank-visuals";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import type { BeltGroup, TipDragPosition } from "@/lib/belt-tracker-page-model";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripVertical,
  Layers,
  Pencil,
  Plus,
  Save,
  Tag,
  Trash2,
} from "lucide-react";

type RankPlanPanelProps = {
  collapsedGroups: Set<string>;
  currentProgramReady: boolean;
  dirty: boolean;
  dragOverGroupIdx: number | null;
  dragOverTip: TipDragPosition | null;
  draggingGroupIdx: number | null;
  draggingTip: TipDragPosition | null;
  editingTerm: boolean;
  groups: BeltGroup[];
  hasCurrentLadder: boolean;
  hasSelectedProgram: boolean;
  isProgramsLoadErrorDismissed: boolean;
  isSaving: boolean;
  ladderError: string | null;
  onAddBelt: () => void;
  onAddTip: (groupIndex: number) => void;
  onBeltDragEnd: () => void;
  onBeltDragOver: (groupIndex: number, event: DragEvent) => void;
  onBeltDragStart: (groupIndex: number, event: DragEvent) => void;
  onBeltDrop: (groupIndex: number) => void;
  onDeleteRank: (rankId: string) => void;
  onDiscardChanges: () => void;
  onDismissLadderError: () => void;
  onDismissProgramsLoadError: () => void;
  onDismissSaveError: () => void;
  onEditRank: (rankId: string) => void;
  onMoveBelt: (groupIndex: number, direction: -1 | 1) => void;
  onMoveTip: (groupIndex: number, tipIndex: number, direction: -1 | 1) => void;
  onSaveRanks: () => void;
  onStartEditingTerm: () => void;
  onStopEditingTerm: () => void;
  onSubmitSubRankTerm: (event: FormEvent<HTMLFormElement>) => void;
  onTermDraftChange: (value: string) => void;
  onTipDragEnd: () => void;
  onTipDragOver: (groupIndex: number, tipIndex: number, event: DragEvent) => void;
  onTipDragStart: (groupIndex: number, tipIndex: number, event: DragEvent) => void;
  onTipDrop: (groupIndex: number, tipIndex: number) => void;
  onToggleGroup: (rankId: string) => void;
  programsLoadError: string | null;
  saveError: string | null;
  subRankTerm: string;
  termDraft: string;
  title: string;
  tipCount: number;
};

export function RankPlanPanel({
  collapsedGroups,
  currentProgramReady,
  dirty,
  dragOverGroupIdx,
  dragOverTip,
  draggingGroupIdx,
  draggingTip,
  editingTerm,
  groups,
  hasCurrentLadder,
  hasSelectedProgram,
  isProgramsLoadErrorDismissed,
  isSaving,
  ladderError,
  onAddBelt,
  onAddTip,
  onBeltDragEnd,
  onBeltDragOver,
  onBeltDragStart,
  onBeltDrop,
  onDeleteRank,
  onDiscardChanges,
  onDismissLadderError,
  onDismissProgramsLoadError,
  onDismissSaveError,
  onEditRank,
  onMoveBelt,
  onMoveTip,
  onSaveRanks,
  onStartEditingTerm,
  onStopEditingTerm,
  onSubmitSubRankTerm,
  onTermDraftChange,
  onTipDragEnd,
  onTipDragOver,
  onTipDragStart,
  onTipDrop,
  onToggleGroup,
  programsLoadError,
  saveError,
  subRankTerm,
  termDraft,
  title,
  tipCount,
}: RankPlanPanelProps) {
  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="max-w-xl">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            <p className="text-xs text-muted mt-0.5">
              {groups.length} belts · {tipCount} {subRankTerm.toLowerCase()}s total
            </p>

            <div className="flex items-center gap-1.5 mt-2">
              <Layers aria-hidden="true" className="w-3 h-3 text-muted" />
              <span className="text-xs text-muted">Sub-rank term:</span>
              {editingTerm ? (
                <form onSubmit={onSubmitSubRankTerm} className="flex items-center gap-1">
                  <input
                    type="text"
                    value={termDraft}
                    onChange={(event) => onTermDraftChange(event.target.value)}
                    autoFocus
                    aria-label="Sub-rank term"
                    className="px-1.5 py-0.5 text-xs bg-surface-raised border border-accent rounded-[4px] text-text-primary focus:outline-none w-20"
                  />
                  <button type="submit" className="text-xs text-accent hover:text-accent/80 cursor-pointer font-medium">
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={onStopEditingTerm}
                    aria-label="Cancel editing sub-rank term"
                    className="text-xs text-muted hover:text-text-secondary cursor-pointer"
                  >
                    ✕
                  </button>
                </form>
              ) : (
                <button
                  onClick={onStartEditingTerm}
                  aria-label="Edit sub-rank term"
                  className="text-xs text-accent font-medium hover:underline cursor-pointer flex items-center gap-1"
                >
                  {subRankTerm}
                  <Pencil aria-hidden="true" className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {dirty && (
              <Button
                variant="ghost"
                size="sm"
                disabled={isSaving}
                onClick={onDiscardChanges}
              >
                Discard
              </Button>
            )}
            {dirty && (
              <Button
                variant="primary"
                size="sm"
                disabled={isSaving || !currentProgramReady}
                onClick={onSaveRanks}
              >
                <Save aria-hidden="true" className="w-3.5 h-3.5" />{isSaving ? "Saving..." : "Save ranks"}
              </Button>
            )}
            <Button variant="secondary" size="sm" disabled={!currentProgramReady} onClick={onAddBelt}>
              <Plus aria-hidden="true" className="w-3.5 h-3.5" />Add belt
            </Button>
          </div>
        </div>

        {ladderError && (
          <DismissibleNotice
            tone="danger"
            onDismiss={onDismissLadderError}
            className="mb-4"
          >
            {ladderError}
          </DismissibleNotice>
        )}
        {programsLoadError && !isProgramsLoadErrorDismissed && (
          <DismissibleNotice
            tone="danger"
            onDismiss={onDismissProgramsLoadError}
            className="mb-4"
          >
            {programsLoadError}
          </DismissibleNotice>
        )}

        {saveError && (
          <DismissibleNotice
            tone="danger"
            onDismiss={onDismissSaveError}
            className="mb-4"
          >
            {saveError}
          </DismissibleNotice>
        )}

        <p className="text-xs text-muted mb-4 flex items-center gap-1.5">
          <GripVertical aria-hidden="true" className="w-3 h-3" />
          Drag belts to reorder. Drag {subRankTerm.toLowerCase()}s within a belt to reorder them.
        </p>

        <div className="space-y-2">
          {groups.map((group, groupIndex) => {
            const isCollapsed = collapsedGroups.has(group.belt.id);
            const isDraggingThisGroup = draggingGroupIdx === groupIndex;
            const isDropTarget = dragOverGroupIdx === groupIndex && draggingGroupIdx !== groupIndex;

            return (
              <div
                key={group.belt.id}
                className={`rounded-[6px] border transition-[background-color,border-color,opacity] ${
                  isDropTarget
                    ? "border-accent bg-accent/5"
                    : "border-border bg-surface"
                } ${isDraggingThisGroup ? "opacity-40" : "opacity-100"}`}
              >
                <div
                  draggable
                  onDragStart={(event) => onBeltDragStart(groupIndex, event)}
                  onDragOver={(event) => onBeltDragOver(groupIndex, event)}
                  onDrop={() => onBeltDrop(groupIndex)}
                  onDragEnd={onBeltDragEnd}
                  className="flex items-center gap-3 px-4 py-3 cursor-default select-none"
                >
                  <GripVertical aria-hidden="true" className="w-3.5 h-3.5 text-muted cursor-grab active:cursor-grabbing flex-shrink-0" />

                  <button
                    type="button"
                    onClick={() => onToggleGroup(group.belt.id)}
                    aria-expanded={!isCollapsed}
                    aria-controls={`rank-group-${group.belt.id}-tips`}
                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.belt.name}`}
                    className="text-muted hover:text-text-secondary transition-colors cursor-pointer flex-shrink-0"
                  >
                    {isCollapsed
                      ? <ChevronRight aria-hidden="true" className="w-3.5 h-3.5" />
                      : <ChevronDown aria-hidden="true" className="w-3.5 h-3.5" />}
                  </button>

                  <BeltVisual rank={group.belt} />

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-text-primary truncate">
                      {group.belt.name}
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      {group.belt.min_classes > 0 ? `${group.belt.min_classes} classes` : ""}
                      {group.belt.min_classes > 0 && group.belt.min_months > 0 ? " · " : ""}
                      {group.belt.min_months > 0 ? `${group.belt.min_months} months` : ""}
                      {group.belt.requires_approval ? " · Approval" : ""}
                      {!group.belt.min_classes && !group.belt.min_months && !group.belt.requires_approval
                        ? groupIndex === 0 ? "Starting belt" : "No requirements"
                        : ""}
                      {group.tips.length > 0
                        ? ` · ${group.tips.length} ${subRankTerm.toLowerCase()}${group.tips.length !== 1 ? "s" : ""}`
                        : ""}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => onMoveBelt(groupIndex, -1)}
                      disabled={groupIndex === 0}
                      aria-label={`Move ${group.belt.name} up`}
                      title="Move belt up"
                      className="p-1.5 rounded-[4px] text-muted hover:text-text-primary hover:bg-surface-raised transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <ChevronUp aria-hidden="true" className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMoveBelt(groupIndex, 1)}
                      disabled={groupIndex === groups.length - 1}
                      aria-label={`Move ${group.belt.name} down`}
                      title="Move belt down"
                      className="p-1.5 rounded-[4px] text-muted hover:text-text-primary hover:bg-surface-raised transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <ChevronDown aria-hidden="true" className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditRank(group.belt.id)}
                      aria-label={`Edit ${group.belt.name}`}
                      className="p-1.5 rounded-[4px] text-muted hover:text-text-primary hover:bg-surface-raised transition-colors cursor-pointer"
                      title="Edit belt"
                    >
                      <Pencil aria-hidden="true" className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteRank(group.belt.id)}
                      aria-label={`Delete ${group.belt.name}`}
                      className="p-1.5 rounded-[4px] text-muted hover:text-danger hover:bg-danger/10 transition-colors cursor-pointer"
                      title="Delete belt"
                    >
                      <Trash2 aria-hidden="true" className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {!isCollapsed && (
                  <div id={`rank-group-${group.belt.id}-tips`} className="ml-10 mr-4 mb-3 border-l-2 border-border pl-4">
                    {group.tips.length === 0 && (
                      <p className="text-xs text-muted italic py-1 mb-1">
                        No {subRankTerm.toLowerCase()}s configured.
                      </p>
                    )}

                    {group.tips.map((tip, tipIndex) => {
                      const isTipDragging = draggingTip?.gIdx === groupIndex && draggingTip?.tIdx === tipIndex;
                      const isTipOver = dragOverTip?.gIdx === groupIndex && dragOverTip?.tIdx === tipIndex
                        && !(draggingTip?.gIdx === groupIndex && draggingTip?.tIdx === tipIndex);

                      return (
                        <div
                          key={tip.id}
                          draggable
                          onDragStart={(event) => onTipDragStart(groupIndex, tipIndex, event)}
                          onDragOver={(event) => onTipDragOver(groupIndex, tipIndex, event)}
                          onDrop={() => onTipDrop(groupIndex, tipIndex)}
                          onDragEnd={onTipDragEnd}
                          className={`flex items-center gap-2.5 py-2 px-2 rounded-[4px] mb-0.5 transition-[background-color,color,opacity] select-none ${
                            isTipDragging ? "opacity-30" : "opacity-100"
                          } ${isTipOver ? "bg-accent/10" : "hover:bg-surface-raised/60"}`}
                        >
                          <GripVertical aria-hidden="true" className="w-3 h-3 text-muted/50 cursor-grab active:cursor-grabbing flex-shrink-0" />
                          <BeltVisual rank={tip} size="sm" />
                          <span className="text-xs text-text-secondary flex-1 truncate font-medium">
                            {tip.name}
                          </span>
                          <span className="text-xs text-muted">
                            {tip.min_classes > 0 ? `${tip.min_classes} cl` : ""}
                            {tip.min_classes > 0 && tip.min_months > 0 ? " · " : ""}
                            {tip.min_months > 0 ? `${tip.min_months} mo` : ""}
                            {tip.requires_approval ? " · ✓" : ""}
                          </span>
                          <div className="flex items-center gap-0.5 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => onMoveTip(groupIndex, tipIndex, -1)}
                              disabled={tipIndex === 0}
                              aria-label={`Move ${tip.name} up`}
                              title={`Move ${subRankTerm.toLowerCase()} up`}
                              className="p-1 rounded-[4px] text-muted hover:text-text-primary hover:bg-surface-raised transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <ChevronUp aria-hidden="true" className="w-2.5 h-2.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onMoveTip(groupIndex, tipIndex, 1)}
                              disabled={tipIndex === group.tips.length - 1}
                              aria-label={`Move ${tip.name} down`}
                              title={`Move ${subRankTerm.toLowerCase()} down`}
                              className="p-1 rounded-[4px] text-muted hover:text-text-primary hover:bg-surface-raised transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <ChevronDown aria-hidden="true" className="w-2.5 h-2.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onEditRank(tip.id)}
                              aria-label={`Edit ${tip.name}`}
                              className="p-1 rounded-[4px] text-muted hover:text-text-primary hover:bg-surface-raised transition-colors cursor-pointer"
                            >
                              <Pencil aria-hidden="true" className="w-2.5 h-2.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteRank(tip.id)}
                              aria-label={`Delete ${tip.name}`}
                              className="p-1 rounded-[4px] text-muted hover:text-danger hover:bg-danger/10 transition-colors cursor-pointer"
                            >
                              <Trash2 aria-hidden="true" className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => onAddTip(groupIndex)}
                      className="flex items-center gap-1.5 text-xs text-muted hover:text-accent transition-colors cursor-pointer mt-1 py-1 px-2 rounded-[4px] hover:bg-surface-raised/60"
                    >
                      <Plus aria-hidden="true" className="w-3 h-3" />
                      Add {subRankTerm.toLowerCase()}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {groups.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center text-muted border border-dashed border-border rounded-[6px]">
              <Tag aria-hidden="true" className="w-6 h-6 mb-2" />
              <p className="text-sm">
                {hasCurrentLadder
                  ? "No belts yet. Add your first belt to get started."
                  : hasSelectedProgram
                    ? "This program is still preparing its rank plan. Refresh programs and try again."
                    : "Create a program in Settings before tracking belts."}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-4"
                disabled={!currentProgramReady}
                onClick={onAddBelt}
              >
                <Plus aria-hidden="true" className="w-3.5 h-3.5" />
                Add belt
              </Button>
            </div>
          )}
        </div>

        {dirty && (
          <p className="text-xs text-warning mt-3 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
            Unsaved changes to rank order.
          </p>
        )}
      </div>
    </div>
  );
}
