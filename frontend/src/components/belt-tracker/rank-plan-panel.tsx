"use client";

import type { DragEvent, FormEvent } from "react";
import { MartialArtsBelt } from "@/components/icons/martial-arts-belt";
import { BeltVisual } from "@/components/belt-tracker/rank-visuals";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { CalmState, HorizonPanel, ToneTag } from "@/components/ui/horizon";
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
  Trash2,
  X,
} from "lucide-react";
import styles from "./belt-tracker.module.css";

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
  /** Students holding each rank, when eligibility for this plan is known. */
  studentCountByRankId?: Map<string, number> | null;
  subRankTerm: string;
  termDraft: string;
  title: string;
  tipCount: number;
};

function requirementWords(rank: {
  min_classes: number;
  min_months: number;
  requires_approval: boolean;
}) {
  return [
    rank.min_classes > 0
      ? `${rank.min_classes} ${rank.min_classes === 1 ? "class" : "classes"}`
      : null,
    rank.min_months > 0 ? `${rank.min_months} ${rank.min_months === 1 ? "month" : "months"}` : null,
    rank.requires_approval ? "Instructor approval" : null,
  ].filter((word): word is string => Boolean(word));
}

function StudentCount({ count }: { count: number | undefined }) {
  if (count === undefined) return null;
  return (
    <span className={styles.rankStudents} data-empty={count === 0 ? "true" : undefined}>
      {count === 0 ? "No students" : `${count} ${count === 1 ? "student" : "students"}`}
    </span>
  );
}

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
  studentCountByRankId = null,
  subRankTerm,
  termDraft,
  title,
  tipCount,
}: RankPlanPanelProps) {
  const countFor = (rankId: string) =>
    studentCountByRankId ? (studentCountByRankId.get(rankId) ?? 0) : undefined;
  return (
    <div
      id="belt-panel-ladder"
      role="tabpanel"
      aria-labelledby="belt-tab-ladder"
      className={styles.rankPlanWorkspace}
    >
      <fieldset disabled={isSaving} className={styles.rankPlan}>
        <div className={styles.rankPlanHeader}>
          <div className={styles.rankPlanTitles}>
            <h2>{title}</h2>
            <p>
              {groups.length} {groups.length === 1 ? "belt" : "belts"} · {tipCount}{" "}
              {subRankTerm.toLowerCase()}
              {tipCount === 1 ? "" : "s"}
            </p>
            <div className={styles.termLine}>
              <Layers aria-hidden="true" className="h-3.5 w-3.5" />
              <span>Sub-rank term:</span>
              {editingTerm ? (
                <form onSubmit={onSubmitSubRankTerm} className={styles.termForm}>
                  <input
                    type="text"
                    value={termDraft}
                    onChange={(event) => onTermDraftChange(event.target.value)}
                    autoFocus
                    aria-label="Sub-rank term"
                  />
                  <Button type="submit" variant="secondary" size="sm">
                    Save
                  </Button>
                  <button
                    type="button"
                    onClick={onStopEditingTerm}
                    aria-label="Cancel editing sub-rank term"
                    className={styles.iconButton}
                  >
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={onStartEditingTerm}
                  aria-label="Edit sub-rank term"
                  className={styles.termButton}
                >
                  {subRankTerm}
                  <Pencil aria-hidden="true" className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          <div className={styles.rankPlanActions}>
            {dirty && (
              <Button variant="ghost" disabled={isSaving} onClick={onDiscardChanges}>
                Discard
              </Button>
            )}
            {dirty && (
              <Button
                variant="primary"
                disabled={isSaving || !currentProgramReady || editingTerm}
                onClick={onSaveRanks}
              >
                <Save aria-hidden="true" className="h-4 w-4" />
                {isSaving ? "Saving..." : "Save ranks"}
              </Button>
            )}
            {groups.length > 0 ? (
              <Button
                variant={dirty ? "secondary" : "primary"}
                disabled={!currentProgramReady}
                onClick={onAddBelt}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                Add belt
              </Button>
            ) : null}
          </div>
        </div>

        {ladderError && (
          <DismissibleNotice tone="danger" onDismiss={onDismissLadderError}>
            {ladderError}
          </DismissibleNotice>
        )}
        {programsLoadError && !isProgramsLoadErrorDismissed && (
          <DismissibleNotice tone="danger" onDismiss={onDismissProgramsLoadError}>
            {programsLoadError}
          </DismissibleNotice>
        )}

        {saveError && (
          <DismissibleNotice tone="danger" onDismiss={onDismissSaveError}>
            {saveError}
          </DismissibleNotice>
        )}

        {groups.length > 0 ? (
          <p className={styles.rankPlanHint}>
            <GripVertical aria-hidden="true" className="h-3.5 w-3.5" />
            Lowest rank first. Drag to reorder, or use the arrows for precise moves.
          </p>
        ) : null}

        <ol className={styles.rankRail} aria-label={`${title} ranks, lowest first`}>
          {groups.map((group, groupIndex) => {
            const isCollapsed = collapsedGroups.has(group.belt.id);
            const isDraggingThisGroup = draggingGroupIdx === groupIndex;
            const isDropTarget = dragOverGroupIdx === groupIndex && draggingGroupIdx !== groupIndex;
            const beltWords = requirementWords(group.belt);
            const tipWord = `${group.tips.length} ${subRankTerm.toLowerCase()}${group.tips.length !== 1 ? "s" : ""}`;

            return (
              <li
                key={group.belt.id}
                data-progression-stratum={groupIndex + 1}
                data-drop-target={isDropTarget || undefined}
                data-dragging={isDraggingThisGroup || undefined}
                className={styles.rankGroup}
              >
                <div
                  onDragOver={(event) => onBeltDragOver(groupIndex, event)}
                  onDrop={() => onBeltDrop(groupIndex)}
                  className={styles.rankHeader}
                >
                  <span
                    draggable={!isSaving && currentProgramReady}
                    data-belt-drag-handle={group.belt.id}
                    aria-hidden="true"
                    title={`Drag ${group.belt.name} to reorder`}
                    onDragStart={(event) => onBeltDragStart(groupIndex, event)}
                    onDragEnd={onBeltDragEnd}
                    className={styles.dragHandle}
                  >
                    <GripVertical aria-hidden="true" className="h-4 w-4" />
                  </span>

                  <button
                    type="button"
                    onClick={() => onToggleGroup(group.belt.id)}
                    aria-expanded={!isCollapsed}
                    aria-controls={`rank-group-${group.belt.id}-tips`}
                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.belt.name}`}
                    className={styles.rankCollapseButton}
                  >
                    {isCollapsed ? (
                      <ChevronRight aria-hidden="true" className="h-4 w-4" />
                    ) : (
                      <ChevronDown aria-hidden="true" className="h-4 w-4" />
                    )}
                  </button>

                  <div className={styles.rankIdentity}>
                    <BeltVisual rank={group.belt} size="lg" />
                    <div className={styles.rankText}>
                      <p className={styles.rankName}>{group.belt.name}</p>
                      <p className={styles.rankMeta}>
                        {beltWords.length
                          ? beltWords.join(" · ")
                          : groupIndex === 0
                            ? "Starting belt"
                            : "No requirements"}
                        {group.tips.length > 0 ? ` · ${tipWord}` : ""}
                      </p>
                    </div>
                    <StudentCount count={countFor(group.belt.id)} />
                  </div>

                  <div className={styles.rankActions}>
                    <button
                      type="button"
                      onClick={() => onMoveBelt(groupIndex, -1)}
                      disabled={groupIndex === 0}
                      aria-label={`Move ${group.belt.name} up`}
                      title="Move belt up"
                      className={styles.iconButton}
                    >
                      <ChevronUp aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMoveBelt(groupIndex, 1)}
                      disabled={groupIndex === groups.length - 1}
                      aria-label={`Move ${group.belt.name} down`}
                      title="Move belt down"
                      className={styles.iconButton}
                    >
                      <ChevronDown aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditRank(group.belt.id)}
                      aria-label={`Edit ${group.belt.name}`}
                      className={styles.iconButton}
                      title="Edit belt"
                    >
                      <Pencil aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteRank(group.belt.id)}
                      aria-label={`Delete ${group.belt.name}`}
                      className={styles.iconButton}
                      data-tone="alert"
                      title="Delete belt"
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {!isCollapsed && (
                  <div id={`rank-group-${group.belt.id}-tips`} className={styles.tipList}>
                    {group.tips.map((tip, tipIndex) => {
                      const isTipDragging =
                        draggingTip?.gIdx === groupIndex && draggingTip?.tIdx === tipIndex;
                      const isTipOver =
                        dragOverTip?.gIdx === groupIndex &&
                        dragOverTip?.tIdx === tipIndex &&
                        !(draggingTip?.gIdx === groupIndex && draggingTip?.tIdx === tipIndex);
                      const tipWords = requirementWords(tip);

                      return (
                        <div
                          key={tip.id}
                          onDragOver={(event) => onTipDragOver(groupIndex, tipIndex, event)}
                          onDrop={() => onTipDrop(groupIndex, tipIndex)}
                          data-dragging={isTipDragging || undefined}
                          data-drop-target={isTipOver || undefined}
                          className={styles.tipRow}
                        >
                          <span
                            draggable={!isSaving && currentProgramReady}
                            data-tip-drag-handle={tip.id}
                            aria-hidden="true"
                            title={`Drag ${tip.name} to reorder`}
                            onDragStart={(event) => onTipDragStart(groupIndex, tipIndex, event)}
                            onDragEnd={onTipDragEnd}
                            className={styles.dragHandle}
                          >
                            <GripVertical aria-hidden="true" className="h-3.5 w-3.5" />
                          </span>
                          <div className={styles.tipIdentity}>
                            <BeltVisual rank={tip} size="sm" />
                            <span className={styles.tipName}>{tip.name}</span>
                            <span className={styles.tipRequirements}>
                              {tipWords.length ? tipWords.join(" · ") : "No requirements"}
                            </span>
                            <StudentCount count={countFor(tip.id)} />
                          </div>
                          <div className={styles.rankActions}>
                            <button
                              type="button"
                              onClick={() => onMoveTip(groupIndex, tipIndex, -1)}
                              disabled={tipIndex === 0}
                              aria-label={`Move ${tip.name} up`}
                              title={`Move ${subRankTerm.toLowerCase()} up`}
                              className={styles.iconButton}
                            >
                              <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onMoveTip(groupIndex, tipIndex, 1)}
                              disabled={tipIndex === group.tips.length - 1}
                              aria-label={`Move ${tip.name} down`}
                              title={`Move ${subRankTerm.toLowerCase()} down`}
                              className={styles.iconButton}
                            >
                              <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onEditRank(tip.id)}
                              aria-label={`Edit ${tip.name}`}
                              className={styles.iconButton}
                            >
                              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteRank(tip.id)}
                              aria-label={`Delete ${tip.name}`}
                              className={styles.iconButton}
                              data-tone="alert"
                            >
                              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => onAddTip(groupIndex)}
                      className={styles.addTipButton}
                    >
                      <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                      Add {subRankTerm.toLowerCase()}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        {groups.length === 0 && (
          <HorizonPanel>
            <CalmState
              tone="neutral"
              icon={<MartialArtsBelt />}
              title="Build this program's rank plan"
              detail={
                hasCurrentLadder
                  ? "No belts yet. Add your first belt to get started."
                  : hasSelectedProgram
                    ? "This program is still preparing its rank plan. Refresh programs and try again."
                    : "Create a program in Settings before tracking belts."
              }
              action={
                <Button variant="primary" disabled={!currentProgramReady} onClick={onAddBelt}>
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  Add belt
                </Button>
              }
            />
          </HorizonPanel>
        )}

        {dirty && (
          <p className={styles.unsavedLine}>
            <ToneTag tone="warn">Unsaved</ToneTag>
            Changes to this rank plan are not saved yet.
          </p>
        )}
      </fieldset>
    </div>
  );
}
