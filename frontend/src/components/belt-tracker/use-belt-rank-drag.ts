"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  moveBeltGroup,
  moveTipWithinGroup,
  type BeltGroup,
  type TipDragPosition,
} from "@/lib/belt-tracker-page-model";
import type { BeltRank } from "@/types";

type UseBeltRankDragArgs = {
  groups: BeltGroup[];
  onReorderRanks: (nextRanks: BeltRank[]) => void;
};

type MoveDirection = -1 | 1;

export function useBeltRankDrag({
  groups,
  onReorderRanks,
}: UseBeltRankDragArgs) {
  const dragGroupIdx = useRef<number | null>(null);
  const [draggingGroupIdx, setDraggingGroupIdx] = useState<number | null>(null);
  const [dragOverGroupIdx, setDragOverGroupIdx] = useState<number | null>(null);

  const dragTip = useRef<TipDragPosition | null>(null);
  const [draggingTip, setDraggingTip] = useState<TipDragPosition | null>(null);
  const [dragOverTip, setDragOverTip] = useState<TipDragPosition | null>(null);

  const resetGroupDrag = useCallback(() => {
    dragGroupIdx.current = null;
    setDraggingGroupIdx(null);
    setDragOverGroupIdx(null);
  }, []);

  const resetTipDrag = useCallback(() => {
    dragTip.current = null;
    setDraggingTip(null);
    setDragOverTip(null);
  }, []);

  const onBeltDragStart = useCallback((groupIndex: number, event: DragEvent) => {
    dragGroupIdx.current = groupIndex;
    setDraggingGroupIdx(groupIndex);
    event.dataTransfer.effectAllowed = "move";
  }, []);

  const onBeltDragOver = useCallback((groupIndex: number, event: DragEvent) => {
    event.preventDefault();
    setDragOverGroupIdx(groupIndex);
  }, []);

  const onBeltDrop = useCallback((dropGroupIndex: number) => {
    const nextRanks = moveBeltGroup(groups, dragGroupIdx.current, dropGroupIndex);
    if (nextRanks) {
      onReorderRanks(nextRanks);
    }
    resetGroupDrag();
  }, [groups, onReorderRanks, resetGroupDrag]);

  const onMoveBelt = useCallback((groupIndex: number, direction: MoveDirection) => {
    const nextIndex = groupIndex + direction;
    if (nextIndex < 0 || nextIndex >= groups.length) {
      return;
    }

    const nextRanks = moveBeltGroup(groups, groupIndex, nextIndex);
    if (nextRanks) {
      onReorderRanks(nextRanks);
    }
    resetGroupDrag();
  }, [groups, onReorderRanks, resetGroupDrag]);

  const onTipDragStart = useCallback((
    groupIndex: number,
    tipIndex: number,
    event: DragEvent
  ) => {
    event.stopPropagation();
    dragTip.current = { gIdx: groupIndex, tIdx: tipIndex };
    setDraggingTip({ gIdx: groupIndex, tIdx: tipIndex });
    event.dataTransfer.effectAllowed = "move";
  }, []);

  const onTipDragOver = useCallback((
    groupIndex: number,
    tipIndex: number,
    event: DragEvent
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverTip({ gIdx: groupIndex, tIdx: tipIndex });
  }, []);

  const onTipDrop = useCallback((dropGroupIndex: number, dropTipIndex: number) => {
    const nextRanks = moveTipWithinGroup(groups, dragTip.current, dropGroupIndex, dropTipIndex);
    if (nextRanks) {
      onReorderRanks(nextRanks);
    }
    resetTipDrag();
  }, [groups, onReorderRanks, resetTipDrag]);

  const onMoveTip = useCallback((groupIndex: number, tipIndex: number, direction: MoveDirection) => {
    const nextIndex = tipIndex + direction;
    const group = groups[groupIndex];
    if (!group || nextIndex < 0 || nextIndex >= group.tips.length) {
      return;
    }

    const nextRanks = moveTipWithinGroup(
      groups,
      { gIdx: groupIndex, tIdx: tipIndex },
      groupIndex,
      nextIndex
    );
    if (nextRanks) {
      onReorderRanks(nextRanks);
    }
    resetTipDrag();
  }, [groups, onReorderRanks, resetTipDrag]);

  return {
    dragOverGroupIdx,
    dragOverTip,
    draggingGroupIdx,
    draggingTip,
    onBeltDragEnd: resetGroupDrag,
    onBeltDragOver,
    onBeltDragStart,
    onBeltDrop,
    onMoveBelt,
    onMoveTip,
    onTipDragEnd: resetTipDrag,
    onTipDragOver,
    onTipDragStart,
    onTipDrop,
  };
}
