"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { RankFormData } from "@/components/belt-tracker/rank-form-modal";
import { useBeltRankDrag } from "@/components/belt-tracker/use-belt-rank-drag";
import { api } from "@/lib/api";
import {
  appendTipToGroup,
  buildBeltTrackerProgramState,
  buildEligibilityGroups,
  buildLoadNoticeDismissalKey,
  buildNewBeltRank,
  buildNewTipRank,
  buildPromotionRequestBody,
  deleteRankAndFollowingTips,
  groupRanks,
  normalizeSubRankTermDraft,
  updateRankFromForm,
  validatePromotionTarget,
} from "@/lib/belt-tracker-page-model";
import type {
  BeltsStoreContextValue,
  ConfigStoreContextValue,
  ProgramsStoreContextValue,
  StudentsStoreContextValue,
} from "@/lib/store-contexts";
import { hasStaffPermission } from "@/lib/staff-permissions";
import type { EligibilityEntry, Promotion } from "@/types";

type BeltTrackerPageControllerOptions = {
  beltStore: BeltsStoreContextValue;
  config: Pick<ConfigStoreContextValue, "currentRole" | "isPreviewMode" | "token">;
  programsStore: Pick<
    ProgramsStoreContextValue,
    "programs" | "programsLoaded" | "programsLoadError" | "refreshPrograms"
  >;
  studentsStore: Pick<StudentsStoreContextValue, "refreshStudents">;
};

export function useBeltTrackerPageController({
  beltStore,
  config,
  programsStore,
  studentsStore,
}: BeltTrackerPageControllerOptions) {
  const {
    beltLadders,
    beltRanks,
    currentLadderId,
    eligibility,
    eligibilityLadderId,
    eligibilityLoadError,
    eligibilityPendingLadderId,
    ladderName,
    promoteStudent,
    setBeltRanks,
    setCurrentLadder,
    subRankTerm: storeSubRankTerm,
  } = beltStore;
  const { isPreviewMode, token } = config;
  const canConfigureBelts = hasStaffPermission(config.currentRole, "configure_belts");
  const canPromoteStudents = hasStaffPermission(config.currentRole, "promote_students");
  const { programs, programsLoaded, programsLoadError, refreshPrograms } = programsStore;
  const { refreshStudents } = studentsStore;

  const [tab, setTab] = useState<"eligibility" | "ladder">("eligibility");
  const visibleTab = canConfigureBelts ? tab : "eligibility";
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(null);
  const [draftRanks, setDraftRanks] = useState(beltRanks);
  const [draftSubRankTerm, setDraftSubRankTerm] = useState(storeSubRankTerm);
  const [editingTerm, setEditingTerm] = useState(false);
  const [termDraft, setTermDraft] = useState(storeSubRankTerm);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ladderError, setLadderError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [dismissedLoadNotices, setDismissedLoadNotices] = useState<Set<string>>(new Set());
  const [isSwitchingLadder, setIsSwitchingLadder] = useState(false);
  const [collapsedEligibilityGroups, setCollapsedEligibilityGroups] = useState<Set<string>>(new Set());
  const [addBeltModal, setAddBeltModal] = useState(false);
  const [addTipForGroup, setAddTipForGroup] = useState<number | null>(null);
  const [editRankId, setEditRankId] = useState<string | null>(null);
  const [deleteRankId, setDeleteRankId] = useState<string | null>(null);
  const [promoteEntry, setPromoteEntry] = useState<EligibilityEntry | null>(null);
  const [promotionNotes, setPromotionNotes] = useState("");
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const [isPromoting, setIsPromoting] = useState(false);
  const promotionInFlightRef = useRef(false);
  const [demoteEntry, setDemoteEntry] = useState<EligibilityEntry | null>(null);
  const [demotionReason, setDemotionReason] = useState("");
  const [demotionError, setDemotionError] = useState<string | null>(null);
  const [isDemoting, setIsDemoting] = useState(false);
  const demotionInFlightRef = useRef(false);

  useEffect(() => {
    if (!programsLoaded && !programsLoadError) {
      void refreshPrograms().catch(() => undefined);
    }
  }, [programsLoaded, programsLoadError, refreshPrograms]);

  const {
    activeLadderRanks,
    beltPrograms,
    currentLadder,
    currentProgramReady,
    ladderByProgramId,
    selectedProgram,
  } = useMemo(
    () => buildBeltTrackerProgramState({
      beltLadders,
      currentLadderId,
      programs,
      selectedProgramId,
      storeBeltRanks: beltRanks,
    }),
    [beltLadders, beltRanks, currentLadderId, programs, selectedProgramId]
  );

  const ladderRanks = dirty ? draftRanks : activeLadderRanks;
  const eligibilityRanks = activeLadderRanks;
  const subRankTerm = dirty
    ? draftSubRankTerm
    : currentLadder?.sub_rank_term || storeSubRankTerm;
  const groups = useMemo(() => groupRanks(ladderRanks), [ladderRanks]);
  const editRank = editRankId ? ladderRanks.find((rank) => rank.id === editRankId) ?? null : null;
  const deleteRank = deleteRankId ? ladderRanks.find((rank) => rank.id === deleteRankId) ?? null : null;
  const tipCount = useMemo(
    () => ladderRanks.filter((rank) => rank.is_tip).length,
    [ladderRanks]
  );
  const rankById = useMemo(
    () => new Map(eligibilityRanks.map((rank) => [rank.id, rank])),
    [eligibilityRanks]
  );
  const previousRankByCurrentRankId = useMemo(() => {
    const orderedRanks = [...eligibilityRanks].sort(
      (left, right) => left.display_order - right.display_order
    );
    return new Map(
      orderedRanks.slice(1).map((rank, index) => [rank.id, orderedRanks[index]])
    );
  }, [eligibilityRanks]);
  const demotionTargetRank = demoteEntry?.current_rank_id
    ? previousRankByCurrentRankId.get(demoteEntry.current_rank_id) ?? null
    : null;
  const eligibilityMatchesLadder = Boolean(currentLadder?.id && eligibilityLadderId === currentLadder.id);
  const visibleEligibility = useMemo(
    () => eligibilityMatchesLadder ? eligibility : [],
    [eligibility, eligibilityMatchesLadder]
  );
  const isEligibilityLoading = Boolean(
    currentLadder
      && (
        isSwitchingLadder
        || eligibilityPendingLadderId === currentLadder.id
        || (!eligibilityMatchesLadder && !eligibilityLoadError)
      )
  );
  const eligibilityGroups = useMemo(
    () => buildEligibilityGroups(visibleEligibility, eligibilityRanks),
    [eligibilityRanks, visibleEligibility]
  );

  const isLoadNoticeDismissed = useCallback((key: string, message: string | null) => {
    const noticeKey = buildLoadNoticeDismissalKey(key, message);
    return Boolean(noticeKey && dismissedLoadNotices.has(noticeKey));
  }, [dismissedLoadNotices]);

  const dismissLoadNotice = useCallback((key: string, message: string | null) => {
    const noticeKey = buildLoadNoticeDismissalKey(key, message);
    if (!noticeKey) return;
    setDismissedLoadNotices((current) => new Set(current).add(noticeKey));
  }, []);

  const handleSelectLadder = useCallback(async (nextLadderId: string) => {
    if (!nextLadderId || nextLadderId === currentLadderId) {
      return;
    }

    setIsSwitchingLadder(true);
    setLadderError(null);
    try {
      await setCurrentLadder(nextLadderId);
      setCollapsedEligibilityGroups(new Set());
    } catch (error) {
      console.error("Failed to switch belt ladder", error);
      setLadderError("Could not switch ladders right now. Please try again.");
    } finally {
      setIsSwitchingLadder(false);
    }
  }, [currentLadderId, setCurrentLadder]);

  const handleSelectProgram = useCallback((nextProgramId: string | null) => {
    setSelectedProgramId(nextProgramId);
    const nextLadder = nextProgramId ? ladderByProgramId.get(nextProgramId) : null;
    if (nextLadder && !dirty) {
      void handleSelectLadder(nextLadder.id);
    }
  }, [dirty, handleSelectLadder, ladderByProgramId]);

  const updateRanks = useCallback((updater: (current: typeof ladderRanks) => typeof ladderRanks) => {
    setSaveError(null);
    setLadderError(null);
    setActionMessage(null);
    setDraftRanks((currentDraft) => updater(dirty ? currentDraft : ladderRanks));
    setDirty(true);
  }, [dirty, ladderRanks]);

  const handleReorderRanks = useCallback((nextRanks: typeof ladderRanks) => {
    updateRanks(() => nextRanks);
  }, [updateRanks]);
  const rankDrag = useBeltRankDrag({ groups, onReorderRanks: handleReorderRanks });

  function handleAddBelt(data: RankFormData) {
    if (!currentLadder || !currentProgramReady) return;
    const newRank = buildNewBeltRank({
      data,
      displayOrder: ladderRanks.length,
      ladderId: currentLadder.id,
    });
    updateRanks((currentRanks) => [...currentRanks, newRank]);
    setAddBeltModal(false);
  }

  function handleAddTip(groupIndex: number, data: RankFormData) {
    if (!currentLadder || !currentProgramReady) return;
    const group = groups[groupIndex];
    if (!group) return;

    const newTip = buildNewTipRank({
      beltColorHex: group.belt.color_hex,
      data,
      ladderId: currentLadder.id,
    });
    const nextRanks = appendTipToGroup(groups, groupIndex, newTip);
    if (nextRanks) {
      updateRanks(() => nextRanks);
    }
    setAddTipForGroup(null);
  }

  function handleEdit(data: RankFormData) {
    if (!editRankId) return;
    updateRanks((currentRanks) => updateRankFromForm(currentRanks, editRankId, data));
    setEditRankId(null);
  }

  function handleDelete() {
    if (!deleteRankId) return;
    updateRanks((currentRanks) => deleteRankAndFollowingTips(currentRanks, deleteRankId));
    setDeleteRankId(null);
  }

  function toggleCollapse(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleSaveRanks() {
    setSaveError(null);
    if (!currentLadder || !currentProgramReady) {
      setSaveError("Program ranks are still loading. Please try again in a moment.");
      return;
    }
    setIsSaving(true);
    try {
      await setBeltRanks(ladderRanks, { subRankTerm });
      setDirty(false);
      setActionMessage("Program ranks saved.");
    } catch (error) {
      console.error("Failed to save belt ranks", error);
      setSaveError("Could not save ladder changes. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleDiscardChanges() {
    setDraftRanks(beltRanks);
    setDraftSubRankTerm(storeSubRankTerm);
    setTermDraft(storeSubRankTerm);
    setDirty(false);
    setSaveError(null);
    setLadderError(null);
    setActionMessage(null);
  }

  function handleSubmitSubRankTerm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTerm = normalizeSubRankTermDraft(termDraft);
    setSaveError(null);
    setDraftSubRankTerm(nextTerm);
    setTermDraft(nextTerm);
    setDirty(nextTerm !== storeSubRankTerm || dirty);
    setEditingTerm(false);
  }

  function toggleEligibilityGroup(groupKey: string) {
    setCollapsedEligibilityGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }

  const handleStartPromotion = useCallback((entry: EligibilityEntry) => {
    if (!canPromoteStudents) return;
    if (!entry.next_rank_id) {
      return;
    }
    setPromotionError(null);
    setPromotionNotes("");
    setPromoteEntry(entry);
  }, [canPromoteStudents]);

  async function handleConfirmPromotion() {
    if (!canPromoteStudents || !promoteEntry || promotionInFlightRef.current) return;

    const validationError = validatePromotionTarget({
      currentLadder,
      promoteEntry,
      selectedProgram,
    });
    if (validationError) {
      setPromotionError(validationError);
      return;
    }

    const targetRankId = promoteEntry.next_rank_id;
    if (!targetRankId) return;

    promotionInFlightRef.current = true;
    setIsPromoting(true);
    setPromotionError(null);
    try {
      if (isPreviewMode) {
        await promoteStudent(
          promoteEntry.student_id,
          targetRankId,
          promotionNotes.trim() || undefined
        );
      } else {
        if (!token) {
          throw new Error("Not authenticated");
        }
        await api.post<Promotion>(
          "/belts/promote",
          buildPromotionRequestBody(promoteEntry, targetRankId, promotionNotes),
          token
        );
        await Promise.all([
          refreshStudents().catch(() => []),
          currentLadderId ? setCurrentLadder(currentLadderId) : Promise.resolve(),
        ]);
      }
      setActionMessage(`${promoteEntry.student_name} promoted to ${promoteEntry.next_rank_name}.`);
      setPromoteEntry(null);
      setPromotionNotes("");
    } catch (error) {
      console.error("Failed to promote student", error);
      setPromotionError("Could not record the promotion. Please try again.");
    } finally {
      promotionInFlightRef.current = false;
      setIsPromoting(false);
    }
  }

  const handleStartDemotion = useCallback((entry: EligibilityEntry) => {
    if (!canPromoteStudents || !entry.current_rank_id) return;
    if (!previousRankByCurrentRankId.has(entry.current_rank_id)) return;
    setDemotionError(null);
    setDemotionReason("");
    setDemoteEntry(entry);
  }, [canPromoteStudents, previousRankByCurrentRankId]);

  async function handleConfirmDemotion() {
    if (
      !canPromoteStudents
      || !demoteEntry
      || !demotionTargetRank
      || demotionInFlightRef.current
    ) return;

    const reason = demotionReason.trim();
    if (!reason) {
      setDemotionError("Add a reason so this demotion is auditable.");
      return;
    }

    demotionInFlightRef.current = true;
    setIsDemoting(true);
    setDemotionError(null);
    try {
      if (isPreviewMode) {
        await promoteStudent(demoteEntry.student_id, demotionTargetRank.id, reason);
      } else {
        if (!token) {
          throw new Error("Not authenticated");
        }
        await api.post<Promotion>(
          "/belts/demote",
          {
            student_id: demoteEntry.student_id,
            to_rank_id: demotionTargetRank.id,
            student_program_membership_id: demoteEntry.student_program_membership_id,
            program_id: demoteEntry.program_id,
            reason,
          },
          token
        );
        await Promise.all([
          refreshStudents().catch(() => []),
          currentLadderId ? setCurrentLadder(currentLadderId) : Promise.resolve(),
        ]);
      }
      setActionMessage(
        `${demoteEntry.student_name} demoted to ${demotionTargetRank.name}.`
      );
      setDemoteEntry(null);
      setDemotionReason("");
    } catch (error) {
      console.error("Failed to demote student", error);
      setDemotionError("Could not record the demotion. Please try again.");
    } finally {
      demotionInFlightRef.current = false;
      setIsDemoting(false);
    }
  }

  return {
    dialogsProps: {
      addBeltModalOpen: canConfigureBelts && addBeltModal,
      addTipForGroup: canConfigureBelts ? addTipForGroup : null,
      deleteRank: canConfigureBelts ? deleteRank : null,
      editRank: canConfigureBelts ? editRank : null,
      groups,
      demoteEntry: canPromoteStudents ? demoteEntry : null,
      demotionError,
      demotionReason,
      demotionTargetRank,
      isDemoting,
      isPromoting,
      onAddBeltClose: () => setAddBeltModal(false),
      onAddBeltSave: handleAddBelt,
      onAddTipClose: () => setAddTipForGroup(null),
      onAddTipSave: handleAddTip,
      onCancelPromotion: () => {
        setPromoteEntry(null);
        setPromotionError(null);
        setPromotionNotes("");
      },
      onCancelDemotion: () => {
        setDemoteEntry(null);
        setDemotionError(null);
        setDemotionReason("");
      },
      onCloseDemotion: () => setDemoteEntry(null),
      onConfirmDemotion: handleConfirmDemotion,
      onClosePromotion: () => setPromoteEntry(null),
      onConfirmDelete: handleDelete,
      onConfirmPromotion: handleConfirmPromotion,
      onDeleteCancel: () => setDeleteRankId(null),
      onDismissPromotionError: () => setPromotionError(null),
      onDismissDemotionError: () => setDemotionError(null),
      onEditClose: () => setEditRankId(null),
      onEditSave: handleEdit,
      onPromotionNotesChange: setPromotionNotes,
      onDemotionReasonChange: setDemotionReason,
      promoteEntry: canPromoteStudents ? promoteEntry : null,
      promotionError,
      promotionNotes,
      rankById,
      subRankTerm,
    },
    eligibilityPanelProps: {
      canConfigureBelts,
      canPromoteStudents,
      collapsedGroups: collapsedEligibilityGroups,
      eligibilityGroups,
      eligibilityLoadError,
      isEligibilityLoading,
      isEligibilityLoadErrorDismissed: isLoadNoticeDismissed("eligibility", eligibilityLoadError),
      isProgramsLoadErrorDismissed: isLoadNoticeDismissed("programs", programsLoadError),
      ladderError,
      onConfigureRanks: () => {
        if (canConfigureBelts) setTab("ladder");
      },
      onDismissEligibilityLoadError: () => dismissLoadNotice("eligibility", eligibilityLoadError),
      onDismissLadderError: () => setLadderError(null),
      onDismissProgramsLoadError: () => dismissLoadNotice("programs", programsLoadError),
      onStartPromotion: handleStartPromotion,
      onStartDemotion: handleStartDemotion,
      onToggleGroup: toggleEligibilityGroup,
      onViewStudents: () => window.location.assign("/students"),
      programsLoadError,
      rankById,
      previousRankByCurrentRankId,
      selectedProgramName: selectedProgram?.name ?? null,
    },
    rankPlanPanelProps: {
      collapsedGroups: collapsed,
      currentProgramReady,
      dirty,
      dragOverGroupIdx: rankDrag.dragOverGroupIdx,
      dragOverTip: rankDrag.dragOverTip,
      draggingGroupIdx: rankDrag.draggingGroupIdx,
      draggingTip: rankDrag.draggingTip,
      editingTerm,
      groups,
      hasCurrentLadder: Boolean(currentLadder),
      hasSelectedProgram: Boolean(selectedProgram),
      isProgramsLoadErrorDismissed: isLoadNoticeDismissed("programs", programsLoadError),
      isSaving,
      ladderError,
      onAddBelt: () => setAddBeltModal(true),
      onAddTip: setAddTipForGroup,
      onBeltDragEnd: rankDrag.onBeltDragEnd,
      onBeltDragOver: rankDrag.onBeltDragOver,
      onBeltDragStart: rankDrag.onBeltDragStart,
      onBeltDrop: rankDrag.onBeltDrop,
      onDeleteRank: setDeleteRankId,
      onDiscardChanges: handleDiscardChanges,
      onDismissLadderError: () => setLadderError(null),
      onDismissProgramsLoadError: () => dismissLoadNotice("programs", programsLoadError),
      onDismissSaveError: () => setSaveError(null),
      onEditRank: setEditRankId,
      onMoveBelt: rankDrag.onMoveBelt,
      onMoveTip: rankDrag.onMoveTip,
      onSaveRanks: handleSaveRanks,
      onStartEditingTerm: () => {
        setTermDraft(subRankTerm);
        setEditingTerm(true);
      },
      onStopEditingTerm: () => setEditingTerm(false),
      onSubmitSubRankTerm: handleSubmitSubRankTerm,
      onTermDraftChange: setTermDraft,
      onTipDragEnd: rankDrag.onTipDragEnd,
      onTipDragOver: rankDrag.onTipDragOver,
      onTipDragStart: rankDrag.onTipDragStart,
      onTipDrop: rankDrag.onTipDrop,
      onToggleGroup: toggleCollapse,
      programsLoadError,
      saveError,
      subRankTerm,
      termDraft,
      title: selectedProgram?.name || currentLadder?.name || ladderName || "Program ranks",
      tipCount,
    },
    shellProps: {
      actionMessage,
      beltPrograms,
      canConfigureBelts,
      dirty,
      isSwitchingLadder,
      onDismissActionMessage: () => setActionMessage(null),
      onSelectProgram: handleSelectProgram,
      onTabChange: (nextTab: "eligibility" | "ladder") => {
        if (nextTab === "eligibility" || canConfigureBelts) setTab(nextTab);
      },
      programsLoaded,
      selectedProgramId: selectedProgram?.id ?? null,
      tab: visibleTab,
    },
    tab: visibleTab,
  };
}

export type BeltTrackerPageController = ReturnType<typeof useBeltTrackerPageController>;
